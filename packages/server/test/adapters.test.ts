import { once } from "node:events";
import { readFileSync, statSync, writeFileSync } from "node:fs";
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

async function localGithubMcp() {
  const received: { path: string; authorization?: string }[] = [];
  const http = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks).toString());
    if (!("id" in msg)) { res.writeHead(202).end(); return; }
    const authorization = req.headers.authorization;
    received.push({ path: req.url!, authorization });
    const inputSchema = { type: "object", properties: req.url === "/echo-schema" ? { [authorization!]: { type: "string" } } : {} };
    let result;
    switch (msg.method) {
      case "initialize": result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }; break;
      case "tools/list": result = { tools: [{ name: "lookup", inputSchema, annotations: { readOnlyHint: true } },
        { name: "unmarked", inputSchema }, { name: "explicit", inputSchema, annotations: { readOnlyHint: false } }] }; break;
      case "tools/call": result = { content: [{ type: "text", text: authorization }] }; break;
      default: res.writeHead(400).end(); return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const base = "http://127.0.0.1:" + (http.address() as AddressInfo).port;
  const original = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === "https://api.githubcopilot.com") return original(new URL(url.pathname, base), init);
    if (url.hostname !== "127.0.0.1") throw new Error("Unexpected external fetch in fixture");
    return original(input, init);
  });
  cleanup.push(async () => { spy.mockRestore(); http.close(); http.closeAllConnections(); await once(http, "close"); });
  return received;
}

it("lists presets and creates a readonly GitHub adapter with an encrypted token", async () => {
  const received = await localGithubMcp();
  const web = await fixture();
  const presets = root + "/presets", path = presets + "/github";
  expect((await web.read(presets)).status).toBe(401);
  expect((await web.post(path, { auth: "gh" })).status).toBe(401);
  await web.login();
  expect(await (await web.read(presets)).json()).toMatchObject([{ id: "github", name: "GitHub", description: expect.any(String),
    authMethods: ["gh", "token"], variants: ["readonly", "full"] }]);
  expect((await web.post(presets + "/unknown", {})).status).toBe(404);
  for (const input of [{}, { auth: "token", token: " " }, { auth: "gh", variant: "typo" }, { auth: "gh", token: "unused" }]) {
    expect((await web.post(path, input)).status).toBe(400);
  }
  const token = "fixture-github-token-271";
  const response = await web.post(path, { auth: "token", token });
  expect(response.status).toBe(201);
  const adapter: AdapterView = await response.json();
  expect(adapter).toMatchObject({ id: "github", name: "GitHub", kind: "mcp", secretNames: ["GITHUB_TOKEN"], status: { state: "ok" },
    config: { transport: "http", readOnly: true, url: "https://api.githubcopilot.com/mcp/readonly", headers: { Authorization: "Bearer {{secret:GITHUB_TOKEN}}" } } });
  expect(adapter.tools.map(t => [t.name, t.defaultEffect, t.effect])).toEqual([
    ["lookup", "read", "read"], ["unmarked", "read", "read"], ["explicit", "read", "read"],
  ]);
  expect(web.app.capabilities.toolActions.get("mcp-github_unmarked")?.effect).toBe("read");
  expect(received).toContainEqual({ path: "/mcp/readonly", authorization: "Bearer " + token });
  expect(await web.call("mcp-github", "lookup")).toMatchObject({ text: "Bearer [redacted]" });
  expect(JSON.stringify(adapter)).not.toContain(token);
  expect(readFileSync(join(web.dir, "adapters.json"), "utf8")).not.toContain(token);
  expect(readFileSync(join(web.dir, "secrets.json"), "utf8")).not.toContain(token);
  expect(openSecrets(web.dir).get("adapter:github:GITHUB_TOKEN")).toBe(token);
  expect((await web.post(path, { auth: "gh" })).status).toBe(409);
  const reflected = await (await web.change("PATCH", "/github", { config: { ...adapter.config,
    url: "https://api.githubcopilot.com/echo-schema" } })).json();
  expect(reflected.status).toEqual({ state: "error", detail: "Discovered tool metadata contains a configured secret" });
  expect(JSON.stringify(reflected)).not.toContain(token);
  expect(readFileSync(join(web.dir, "adapters.json"), "utf8")).not.toContain(token);
});

it("reports gh login failure and obtains fresh credentials on reconnect and refresh", async () => {
  const received = await localGithubMcp();
  cleanup.push(() => { vi.unstubAllEnvs(); });
  const web = await fixture(); await web.login();
  const gh = join(web.dir, "gh");
  writeFileSync(gh, '#!/bin/sh\necho private-diagnostic >&2\nexit 1\n', { mode: 0o700 });
  vi.stubEnv("PATH", web.dir);
  const response = await web.post(root + "/presets/github", { auth: "gh", variant: "full", id: "github-work", name: "Work" });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ id: "github-work", name: "Work", secretNames: [], config: { url: "https://api.githubcopilot.com/mcp/",
    headers: { Authorization: "Bearer {{gh-token}}" } }, status: { state: "error", detail: "本机 gh 未登录或不可用，请运行 gh auth login" } });
  expect(received).toEqual([]);
  const setGh = (token: string) => writeFileSync(gh, `#!/bin/sh\n[ "$#" = 2 ] && [ "$1" = auth ] && [ "$2" = token ] || exit 1\necho '${token}'\n`);
  setGh("fixture-gh-first");
  const list = async (): Promise<AdapterView[]> => (await web.read(root)).json();
  await expect.poll(async () => (await list())[0]?.status.state, { timeout: 5000 }).toBe("ok");
  expect(received).toContainEqual({ path: "/mcp/", authorization: "Bearer fixture-gh-first" });
  setGh("fixture-gh-second");
  const refreshed: AdapterView = await (await web.post(root + "/github-work/refresh", {})).json();
  expect(refreshed.status.state).toBe("ok");
  expect(refreshed.tools.map(t => t.defaultEffect)).toEqual(["read", "write", "write"]);
  expect(received.at(-1)).toEqual({ path: "/mcp/", authorization: "Bearer fixture-gh-second" });
  expect(await web.call("mcp-github-work", "lookup")).toMatchObject({ text: "Bearer [redacted]" });
  expect(JSON.stringify(refreshed)).not.toContain("fixture-gh-");
  expect(readFileSync(join(web.dir, "adapters.json"), "utf8")).not.toContain("fixture-gh-");
  expect(openSecrets(web.dir).names("adapter:github-work:")).toEqual([]);
}, 10_000);

it("shares one gh lookup across configured arguments, environment, headers and URL during discovery", async () => {
  const received = await localGithubMcp();
  cleanup.push(() => { vi.unstubAllEnvs(); });
  const web = await fixture(); await web.login();
  vi.stubEnv("PATH", web.dir);
  const calls = join(web.dir, "gh-calls");
  vi.stubEnv("GH_FIXTURE_CALLS", calls);
  writeFileSync(join(web.dir, "gh"), '#!/bin/sh\necho called >> "$GH_FIXTURE_CALLS"\necho fixture-gh-shared\n', { mode: 0o700 });
  const cli: AdapterView = await (await web.post(root, { id: "cli-test", kind: "cli", name: "CLI", config: {
    command: process.execPath, env: { API_TOKEN: "{{gh-token}}" }, args: ["-e",
      'if (process.argv[1] !== process.env.API_TOKEN) throw Error(); console.log(process.argv[1])',
      "--", "{{gh-token}}"],
  } })).json();
  expect(cli.tools[0]?.description).toBe("CLI\n[redacted]\n");
  expect(readFileSync(calls, "utf8")).toBe("called\n");
  const mcp: AdapterView = await (await web.post(root, { id: "mcp-test", kind: "mcp", name: "MCP", config: {
    transport: "http", url: "https://api.githubcopilot.com/mcp/{{gh-token}}", headers: { Authorization: "Bearer {{gh-token}}" },
  } })).json();
  expect(mcp.status.state).toBe("ok");
  expect(received.at(-1)).toEqual({ path: "/mcp/fixture-gh-shared", authorization: "Bearer fixture-gh-shared" });
  expect(readFileSync(calls, "utf8")).toBe("called\ncalled\n");
});
