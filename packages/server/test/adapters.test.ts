import { once } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { context, type AlterPlugin } from "@alter/core";
import { expect, it, vi } from "vitest";
import { installedPlugins } from "../src/plugins.ts";
import type { AdapterView } from "../src/adapters/types.ts";
import { openSecrets } from "../src/secrets.ts";
import { cleanup, setup } from "./web-fixture.ts";

const root = "/api/adapters";
async function fixture() {
  const plugins = new Map<string, AlterPlugin>();
  const web = await setup(undefined, false, undefined, Date.now, (app, dir) => {
    const replace = app.replacePlugin;
    vi.spyOn(app, "replacePlugin").mockImplementation(async (id, plugin, preserve) => {
      await replace(id, plugin, preserve);
      if (plugin) plugins.set(id, plugin); else plugins.delete(id);
    });
    return installedPlugins(app, dir, { ALTER_BROWSER: "off" });
  });
  const change = (method: string, path: string, data?: unknown) => fetch(web.base + root + path, { method,
    headers: { cookie: web.sessionCookie(), "content-type": "application/json" }, body: JSON.stringify(data) });
  async function call(id: string, name: string, args: Record<string, unknown> = {}) {
    const tool = plugins.get(id)!.tools.find(t => t.name === id + "_" + name)!;
    const result = await tool.execute(args, {} as Parameters<typeof tool.execute>[1], context);
    if (!result.output) throw new Error("Unexpected parked tool");
    expect(result.details).toMatchObject({ untrusted: true });
    const first = result.output[0];
    return { ...result, output: result.output, text: first?.type === "text" ? first.text : "" };
  }
  return { ...web, change, call, plugins };
}

it("discovers paginated MCP tools, reconnects and reconciles authenticated CRUD and secrets", async () => {
  const web = await fixture();
  const input = { kind: "mcp", id: "local", name: "Local MCP", config: { transport: "stdio", command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))], env: { ADAPTER_TOKEN: "{{secret:TOKEN}}" } },
    secrets: { TOKEN: "fixture-value-27b", UNUSED: "discard-me-25" } };
  for (const [method, path] of [["GET", ""], ["POST", ""], ["PATCH", "/local"], ["POST", "/local/refresh"], ["DELETE", "/local"]] as const) {
    expect((await web.change(method, path)).status).toBe(401);
  }
  await web.login();
  const res = await web.post(root, input), adapter: AdapterView = await res.json();
  expect(res.status).toBe(201);
  expect(adapter).toMatchObject({ id: "local", capabilityId: "mcp-local", config: input.config, status: { state: "ok" },
    tools: [{ name: "read_back", defaultEffect: "read", effect: "read" }, { name: "read_back_2", defaultEffect: "write", effect: "write" },
      { name: "fail", defaultEffect: "write", effect: "write" }] });
  expect(JSON.stringify(adapter)).not.toContain(input.secrets.TOKEN);
  expect((await web.post(root, input)).status).toBe(409);
  const tool = "mcp-local_read_back";
  expect(web.app.capabilities.toolActions.get(tool)?.effect).toBe("read");
  expect(await web.app.borrowSource("fixture", tool, { text: "payload" }, AbortSignal.timeout(5000))).toBe("authenticated\npayload");
  expect(await web.call("mcp-local", "fail")).toMatchObject({ isError: true, text: "fixture failure" });
  const image = await web.call("mcp-local", "read_back_2");
  expect(image.output[1]).toMatchObject({ type: "image", data: "aW1n", mimeType: "image/png" });
  const pid = Number(image.text);
  process.kill(pid, "SIGTERM");
  const list = async (): Promise<AdapterView[]> => (await web.read(root)).json();
  await expect.poll(async () => (await list())[0]?.status.state).toBe("error");
  await expect.poll(async () => (await list())[0]?.status.state, { timeout: 5000 }).toBe("ok");
  const updated = await web.change("PATCH", "/local", { name: "Changed", effects: { read_back: "irreversible" }, secrets: { UNUSED: "" } });
  expect(await updated.json()).toMatchObject({ tools: expect.arrayContaining([expect.objectContaining({ name: "read_back", effect: "irreversible", defaultEffect: "read" })]),
    name: "Changed", secretNames: ["TOKEN"] });
  expect(web.app.capabilities.toolActions.get(tool)?.effect).toBe("irreversible");
  expect((await web.change("PATCH", "/local", { effects: { fail: "invalid" } })).status).toBe(400);
  expect((await web.change("PATCH", "/local", { enabled: false })).status).toBe(200);
  expect(web.app.capabilities.toolActions.has(tool)).toBe(false);
  expect((await list())[0]).toMatchObject({ enabled: false, status: { state: "off" }, tools: adapter.tools.map(t => ({ name: t.name })) });
  await web.change("PATCH", "/local", { enabled: true });
  await web.change("PATCH", "/local", { secrets: { TOKEN: "" } });
  expect((await list())[0]?.status).toMatchObject({ state: "error", detail: "Missing secret: TOKEN" });
  await web.change("PATCH", "/local", { secrets: input.secrets });
  expect(await (await web.post(root + "/local/refresh", {})).json()).toMatchObject({ status: { state: "ok" } });
  const file = join(web.dir, "adapters.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).not.toContain(input.secrets.TOKEN);
  expect(readFileSync(join(web.dir, "secrets.json"), "utf8")).not.toContain(input.secrets.TOKEN);
  const lastPid = Number((await web.call("mcp-local", "read_back_2")).text);
  expect((await web.change("DELETE", "/local")).status).toBe(204);
  expect(() => process.kill(lastPid, 0)).toThrow();
  expect(await list()).toEqual([]);
  expect(web.app.capabilities.toolActions.has(tool)).toBe(false);
  expect(openSecrets(web.dir).names("adapter:local:")).toEqual([]);
  expect((await web.change("POST", "/local/refresh")).status).toBe(404);
}, 20_000);

it("collects CLI help, preserves argv and stdin, bounds output, reports exit codes and enforces timeouts", async () => {
  const web = await fixture();
  await web.login();
  const script = `const args = process.argv.slice(1);
    if (args.includes("--help")) process.stdout.write("usage:" + "h".repeat(9000));
    else if (args.includes("hang")) setInterval(() => {}, 100);
    else if (args.includes("large")) process.stderr.write("z".repeat(25000));
    else { let s = ""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => {
      process.stderr.write(JSON.stringify({args, s})); process.exitCode = 7;
    }); }`;
  const config = { command: process.execPath, args: ["-e", script, "--", "{{secret:PREFIX}}"], timeoutMs: 1500 };
  const input = { id: "node", name: "Node", kind: "cli", config, secrets: { PREFIX: "prefix-value-37" } };
  const adapter = await (await web.post(root, input)).json();
  expect(adapter.tools[0]).toMatchObject({ name: "run", effect: "write", defaultEffect: "write" });
  expect(adapter.tools[0].description).toBe("Node\nusage:" + "h".repeat(7994));
  const args = ["a b", "; echo words", "$(date)", '"quotes"'];
  const run = await web.call("cli-node", "run", { args, stdin: "input\n" });
  expect(run.isError).toBe(true);
  const result = JSON.parse(run.text);
  expect(result.code).toBe(7);
  expect(JSON.parse(result.output)).toEqual({ args: ["prefix-value-37", ...args], s: "input\n" });
  expect(JSON.parse((await web.call("cli-node", "run", { args: ["large"] })).text).output).toHaveLength(20_000);
  await web.change("PATCH", "/node", { config: { ...config, timeoutMs: 150, help: "custom help" } });
  expect(await web.call("cli-node", "run", { args: ["hang"] })).toMatchObject({ isError: true, text: "CLI timed out" });
  expect((await web.change("PATCH", "/node", { config: { ...config, timeoutMs: 600001 } })).status).toBe(400);
  await web.change("PATCH", "/node", { effects: { run: "read" } });
  await web.close();
  const reopened = await web.reopen(); await reopened.login();
  expect(await (await reopened.read(root)).json()).toMatchObject([{ tools: [{ name: "run", description: "Node\ncustom help", effect: "read" }] }]);
  expect(reopened.app.capabilities.toolActions.get("cli-node_run")?.effect).toBe("read");
});

it("adapts an OpenAPI document from HTTP or inline JSON and forwards JSON bodies, path, query and header parameters", async () => {
  const spec = { openapi: "3.0.3", servers: [{ url: "/v1" }], paths: {
    "/items/{id}": { parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
      get: { operationId: "fetchItem", summary: "lookup", parameters: [
        { in: "header", name: "X-Label", schema: { type: "string" } }, { in: "query", name: "q", schema: { type: "string" } },
      ] } },
    "/items": { post: { requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } } } } },
  }, components: { schemas: { Item: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } } } };
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer " + "local-api-002") { res.writeHead(403).end(); return; }
    if (req.url === "/spec") { res.end(JSON.stringify(spec)); return; }
    if (req.method === "GET") {
      res.setHeader("content-type", "text/plain"); res.end([req.url, req.headers["x-label"]].join(" ")); return;
    }
    if (req.method === "POST" && req.url === "/v1/items") {
      res.writeHead(201, { "content-type": "application/json" });
      req.pipe(res); return;
    }
    res.writeHead(404).end();
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  cleanup.push(async () => { http.close(); http.closeAllConnections(); await once(http, "close"); });
  const base = "http://127.0.0.1:" + (http.address() as AddressInfo).port;
  const web = await fixture(); await web.login();
  const config = { spec: "{{secret:BASE}}/spec", headers: { Authorization: "Bearer {{secret:API}}" } };
  const created = await (await web.post(root, { id: "items", kind: "http", name: "Items", config, secrets: { BASE: base, API: "local-api-002" } })).json();
  expect(created).toMatchObject({ capabilityId: "api-items", tools: [{ name: "fetchitem", defaultEffect: "read" }, { name: "post_items", defaultEffect: "write" }] });
  const get = await web.call("api-items", "fetchitem", { id: "one/two", q: "a & b", "X-Label": "tag" });
  expect(JSON.parse(get.text)).toEqual({ status: 200, body: "/v1/items/one%2Ftwo?q=a+%26+b tag" });
  const body = { label: "item" };
  const post = await web.call("api-items", "post_items", { body });
  expect(JSON.parse(post.text)).toEqual({ status: 201, body: JSON.stringify(body) });
  const update = await web.change("PATCH", "/items", { config: { ...config, spec, baseUrl: "{{secret:BASE}}/v1" }, effects: { post_items: "read" } });
  expect(await update.json()).toMatchObject({ status: { state: "ok" } });
  const borrowed = await web.app.borrowSource("fixture", "api-items_post_items", { body }, AbortSignal.timeout(5000));
  expect(JSON.parse(String(borrowed))).toMatchObject({ status: 201 });
});

it.each(["streamable", "sse"])("connects to a local %s MCP endpoint with configured headers", async transportKind => {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
  const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "remote", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: transportKind }] }));
  const streamable = new StreamableHTTPServerTransport({ sessionIdGenerator: () => "fixture-session", enableJsonResponse: true });
  let sse: InstanceType<typeof SSEServerTransport> | undefined;
  if (transportKind === "streamable") await server.connect(streamable);
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer local-mcp-013") { res.writeHead(401).end(); return; }
    if (transportKind === "streamable") await streamable.handleRequest(req, res);
    else if (req.method === "GET") {
      sse = new SSEServerTransport("/messages", res);
      await server.connect(sse);
    } else if (req.url?.startsWith("/messages") && sse) await sse.handlePostMessage(req, res);
    else res.writeHead(405).end();
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  cleanup.push(async () => { await server.close(); http.close(); http.closeAllConnections(); await once(http, "close"); });
  const web = await fixture(); await web.login();
  const config = { transport: "http", url: "http://127.0.0.1:{{secret:PORT}}/mcp", headers: { Authorization: "Bearer {{secret:TOKEN}}" } };
  const adapter = await (await web.post(root, { kind: "mcp", id: "remote", name: "Remote MCP", config,
    secrets: { TOKEN: "local-mcp-013", PORT: String((http.address() as AddressInfo).port) } })).json();
  expect(adapter.status).toMatchObject({ state: "ok" });
  expect(await web.call("mcp-remote", "remote")).toMatchObject({ text: transportKind });
  await web.change("DELETE", "/remote");
});

it("keeps overrides bound to their source tool across collisions, refresh failures and rediscovery", async () => {
  const web = await fixture(); await web.login();
  const id = "long-" + "x".repeat(40);
  const config = (operations: Record<string, string>) => ({
    baseUrl: "http://127.0.0.1", spec: { openapi: "3.1.0", paths: Object.fromEntries(Object.entries(operations)
      .map(([path, operationId]) => [path, { post: { operationId, summary: path } }])) },
  });
  const first = "Upper" + "a".repeat(100), second = first.toLowerCase();
  const input = { id, name: "Long names", kind: "http", config: config({ "/one": first, "/two": second }) };
  const responses = await Promise.all([web.post(root, input), web.post(root, input)]);
  expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
  const created: AdapterView = await responses.find(r => r.status === 201)!.json();
  const [one, two] = created.tools;
  expect(one!.name).not.toBe(two!.name);
  expect((created.capabilityId + "_" + two!.name).length).toBeLessThanOrEqual(64);
  const patch = async (value: unknown): Promise<AdapterView> => (await web.change("PATCH", "/" + id, value)).json();
  const reversed = await patch({ effects: { [one!.name]: "read" }, config: config({ "/two": second, "/one": first }) });
  expect(reversed.tools.map(t => [t.description, t.name, t.effect])).toEqual([["/two", two!.name, "write"], ["/one", one!.name, "read"]]);
  const broken = await patch({ config: { spec: { openapi: "2.0" } } });
  expect(broken).toMatchObject({ status: { state: "error", detail: "Expected OpenAPI 3 document" }, tools: reversed.tools });
  expect(web.app.capabilities.toolActions.has(created.capabilityId + "_" + one!.name)).toBe(false);
  const replaced = await patch({ config: config({ "/new": first + "New" }) });
  expect(replaced).toMatchObject({ effects: {}, tools: [{ effect: "write" }] });
  expect(await (await web.read("/api/plugins")).json()).toContainEqual(expect.objectContaining({ id: created.capabilityId, enabled: true }));
  const raw = { spec: { openapi: "3.1.0", paths: {} }, baseUrl: "http://localhost/?api_key=literal" };
  expect((await web.change("PATCH", "/" + id, { config: raw })).status).toBe(400);
  expect((await web.change("PATCH", "/" + id, { config: { ...raw, baseUrl: "http://localhost", headers: { Authorization: "Bearer literal" } } })).status).toBe(400);
});
