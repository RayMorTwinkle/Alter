import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { reply } from "@alter/core";
import { expandMap, record, type Connection, type DiscoveredTool, type Expand, type HttpConfig } from "./types.ts";

type Obj = Record<string, unknown>;
const methods = new Set(["get", "head", "post", "put", "patch", "delete", "options", "trace"]);

function object(value: unknown): Obj {
  if (!record(value)) throw new Error("Invalid OpenAPI object");
  return value;
}

function pointer(doc: Obj, ref: string) {
  if (!ref.startsWith("#/")) throw new Error("Only references within the OpenAPI document are supported");
  let value: unknown = doc;
  for (const segment of decodeURIComponent(ref.slice(2)).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!record(value) || !Object.hasOwn(value, key)) throw new Error("Unresolved OpenAPI reference");
    value = value[key];
  }
  return value;
}

function resolve(doc: Obj, value: unknown) {
  let resolved = object(value);
  const seen = new Set<string>();
  while (typeof resolved.$ref === "string") {
    if (seen.has(resolved.$ref)) throw new Error("Circular OpenAPI reference");
    seen.add(resolved.$ref);
    resolved = object(pointer(doc, resolved.$ref));
  }
  return resolved;
}

// Each tool publishes a standalone schema, including recursive component schemas it uses.
function toolSchema(doc: Obj, properties: Obj, required: string[]) {
  const definitions: Obj = {};
  const refs = new Map<string, string>();
  function copy(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(copy);
    if (!record(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (key !== "$ref" || typeof child !== "string") return [key, copy(child)];
      let id = refs.get(child);
      if (!id) {
        id = "schema" + refs.size;
        refs.set(child, id);
        definitions[id] = copy(pointer(doc, child));
      }
      return [key, "#/$defs/" + id];
    }));
  }
  return { type: "object", properties: copy(properties), required, additionalProperties: false,
    ...(refs.size ? { $defs: definitions } : {}) };
}

async function limitedText(body: AsyncIterable<Uint8Array> | null, limit: number, truncate: boolean) {
  if (!body) return "";
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > limit) {
      if (!truncate) throw new Error("OpenAPI document exceeds size limit");
      return text.slice(0, limit);
    }
  }
  return (text + decoder.decode()).slice(0, limit);
}

function httpUrl(value: string, base?: string) {
  const url = new URL(value, base);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Expected HTTP(S) URL");
  return url;
}

function operation(doc: Obj, path: string, item: Obj, method: string, op: Obj, base: URL, defaults: Record<string, string>): DiscoveredTool {
  const params = new Map<string, Obj>();
  for (const group of [item.parameters, op.parameters]) {
    if (group === undefined) continue;
    if (!Array.isArray(group)) throw new Error("Invalid OpenAPI parameters");
    for (const value of group) {
      const p = resolve(doc, value);
      if (["path", "header", "query"].includes(String(p.in)) && typeof p.name === "string") params.set(p.in + ":" + p.name, p);
    }
  }
  const properties: Obj = Object.create(null);
  const required: string[] = [];
  let bodyType: string | undefined, unsupportedBody = false;
  if (op.requestBody) {
    const body = resolve(doc, op.requestBody), content = object(body.content);
    bodyType = Object.keys(content).find(key => /^application\/(?:[^;]+\+)?json$/i.test(key));
    unsupportedBody = body.required === true && !bodyType;
    if (bodyType) {
      properties.body = object(content[bodyType]).schema ?? {};
      if (body.required) required.push("body");
    }
  }
  const fields = [...params.values()].map(p => {
    const name = String(p.name);
    let field = name;
    while (Object.hasOwn(properties, field)) field = p.in + "_" + field;
    properties[field] = p.schema ?? { type: "string" };
    if (p.required || p.in === "path") required.push(field);
    return { p, field, name };
  });
  const name = typeof op.operationId === "string" && op.operationId || method + "_" + path;
  return { name, description: String(op.summary || op.description || method.toUpperCase() + " " + path),
    inputSchema: toolSchema(doc, properties, required), defaultEffect: method === "get" || method === "head" ? "read" : "write",
    async call(args, signal) {
      if (unsupportedBody) return reply("This operation requires a non-JSON request body", true);
      const url = new URL(base), headers = new Headers(defaults);
      let pathname = path;
      for (const { p, name, field } of fields) {
        if (!Object.hasOwn(args, field)) continue;
        const value = args[field];
        const explode = p.explode ?? (p.in === "query" && (p.style ?? "form") === "form");
        const values = Array.isArray(value) ? value.map(String) : record(value)
          ? Object.entries(value).flatMap(([k, v]) => explode ? [k + "=" + v] : [k, String(v)]) : [String(value)];
        if (p.in === "path") pathname = pathname.replaceAll("{" + name + "}", () => values.map(encodeURIComponent).join(","));
        else if (p.in === "header") headers.set(name, values.join(","));
        else if (record(value) && (explode || p.style === "deepObject")) {
          for (const [k, v] of Object.entries(value)) url.searchParams.append(p.style === "deepObject" ? name + "[" + k + "]" : k, String(v));
        } else if (explode) {
          for (const v of values) url.searchParams.append(name, v);
        } else url.searchParams.append(name, values.join(p.style === "pipeDelimited" ? "|" : p.style === "spaceDelimited" ? " " : ","));
      }
      url.pathname = url.pathname.replace(/\/$/, "") + pathname;
      if (bodyType && Object.hasOwn(args, "body")) headers.set("content-type", bodyType);
      const payload = bodyType ? JSON.stringify(args.body) : undefined;
      if (payload !== undefined) headers.set("content-length", String(Buffer.byteLength(payload)));
      const request = url.protocol === "https:" ? httpsRequest : httpRequest;
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request(url, { method: method.toUpperCase(), headers: Object.fromEntries(headers),
          signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) }, resolve);
        req.on("error", reject);
        req.end(payload);
      });
      const status = res.statusCode!, type = res.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
      if (method !== "head" && status !== 204 && status !== 304 && type && !type.startsWith("text/") && type !== "application/json" && !type.endsWith("+json")) {
        res.destroy();
        return reply(JSON.stringify({ status, error: "Unsupported response content type" }), true);
      }
      return reply(JSON.stringify({ status, body: await limitedText(res, 20_000, true) }), status < 200 || status >= 300);
    },
  };
}

export async function discoverHttp(config: HttpConfig, expand: Expand, signal: AbortSignal): Promise<Connection> {
  const headers = await expandMap(config.headers, expand);
  let doc: Obj, specUrl: string | undefined;
  if (typeof config.spec === "string" && (!config.spec.trimStart().startsWith("{") || config.spec.trimStart().startsWith("{{"))) {
    specUrl = httpUrl(await expand(config.spec)).href;
    const res = await fetch(specUrl, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    if (!res.ok) { await res.body?.cancel(); throw new Error("OpenAPI document returned HTTP " + res.status); }
    specUrl = res.url;
    doc = object(JSON.parse(await limitedText(res.body, 10_000_000, false)));
  } else doc = typeof config.spec === "string" ? object(JSON.parse(config.spec)) : config.spec;
  if (typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.")) throw new Error("Expected OpenAPI 3 document");
  const server = Array.isArray(doc.servers) && doc.servers[0];
  const serverUrl = record(server) && typeof server.url === "string" ? server.url : "/";
  const variables = record(server) && record(server.variables) ? server.variables : {};
  const address = config.baseUrl ?? serverUrl.replace(/(?<!\{)\{([^{}]+)\}(?!\})/g, (match, key: string) => {
    const variable = variables[key];
    return record(variable) && typeof variable.default === "string" ? variable.default : match;
  });
  if (specUrl && config.baseUrl === undefined && address.includes("{{gh-token}}")) throw new Error("Remote OpenAPI servers cannot request a gh token");
  const base = httpUrl(await expand(address), specUrl);
  const tools: DiscoveredTool[] = [];
  for (const [path, value] of Object.entries(object(doc.paths))) {
    const item = resolve(doc, value);
    for (const [method, op] of Object.entries(item)) if (methods.has(method)) {
      tools.push(operation(doc, path, item, method, object(op), base, headers));
    }
  }
  return { tools };
}
