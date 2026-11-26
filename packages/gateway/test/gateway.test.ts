import { fork } from "node:child_process";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type User, openAccounts } from "../src/accounts.ts";
import { manageInstances } from "../src/instances.ts";
import { openGateway } from "../src/main.ts";
import { gatewayServer } from "../src/server.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "alter-gw-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}
async function unusedPort() {
  const s = createServer(), p = await listen(s);
  await new Promise<void>(resolve => s.close(() => resolve()));
  return p;
}
// Account ports are consecutive. Ephemeral port + 1 can be the gateway client's
// own source port by the time the second instance starts.
async function twoInstancePorts() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const base = randomInt(16000, 30000);
    const probes = [createServer(), createServer()];
    try {
      for (const [i, probe] of probes.entries()) {
        probe.listen(base + i, "127.0.0.1");
        await once(probe, "listening");
      }
      return base;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    } finally {
      await Promise.all(probes.filter(s => s.listening).map(s => new Promise<void>(resolve => s.close(() => resolve()))));
    }
  }
  throw new Error("Could not find two free instance ports");
}
async function adminServer() {
  const s = createServer((_, res) => res.end('{"rss":123}'));
  const port = await listen(s);
  cleanup.push(() => new Promise<void>(resolve => { s.close(() => resolve()); s.closeAllConnections(); }));
  return port;
}
function client(port: number) {
  const base = "http://127.0.0.1:" + port;
  function call(path: string, method = "GET", value?: unknown, cookie = "", extra = {}) {
    return fetch(base + path, { method, headers: { cookie, "Content-Type": "application/json", ...extra }, body: JSON.stringify(value) });
  }
  async function login(username: string, password: string) {
    const res = await call("/gateway/login", "POST", { username, password }, "", { "X-Forwarded-Proto": "https" });
    expect(res.status).toBe(200);
    const header = res.headers.get("set-cookie")!;
    expect(header).toMatch(new RegExp(`^alter_gw_${port}=.*HttpOnly.*SameSite=Lax.*Max-Age=31536000; Secure$`));
    return header.split(";")[0]!;
  }
  async function register(admin: string, username: string) {
    const invitation = await call("/gateway/admin/invites", "POST", {}, admin);
    expect(invitation.status).toBe(201);
    const response = await call("/gateway/register", "POST", { username, password: "password", invite: (await invitation.json()).code });
    expect(response.status).toBe(201);
    return await response.json() as Pick<User, "id" | "username" | "role">;
  }
  return { call, login, register, base };
}
async function fixture() {
  const dir = await temp(), adminPort = await adminServer();
  const accounts = await openAccounts(join(dir, "accounts.sqlite"), await unusedPort(), "admin", "password");
  cleanup.push(accounts.close);
  const instances = manageInstances({ adminPort, env: {}, secret: "admin-secret", usersDir: dir,
    entry: join(import.meta.dirname, "fixtures/instance.mjs"), backoffMs: 100 });
  await writeFile(join(dir, "index.html"), "login app");
  const web = gatewayServer(accounts, instances, dir);
  const port = await listen(web.server);
  cleanup.push(web.close);
  return { ...client(port), dir, accounts };
}

test("admin authorization, registration, revocation, login throttle and static login page", async () => {
  const { call, login, register } = await fixture();
  expect(await (await call("/room")).text()).toBe("login app");
  expect((await call("/api/state")).status).toBe(401);
  expect((await call("/gateway/admin/users")).status).toBe(401);
  const admin = await login("admin", "password");
  const user = await register(admin, "roommate");
  const cookie = await login(user.username, "password");
  expect(await (await call("/gateway/me", "GET", undefined, cookie)).json()).toEqual(user);
  const endpoint = "/gateway/admin/users/" + user.id;
  for (const [path, method] of [[endpoint, "PATCH"], [endpoint + "/restart", "POST"], ["/gateway/admin/users", "GET"],
    ["/gateway/admin/invites", "GET"], ["/gateway/admin/invites", "POST"], ["/gateway/admin/invites/nope", "DELETE"]] as const) {
    expect((await call(path, method, undefined, cookie)).status).toBe(403);
  }
  const listing = await (await call("/gateway/admin/users", "GET", undefined, admin)).json();
  expect(listing).toContainEqual(expect.objectContaining({ username: "admin", instance: expect.objectContaining({ managed: false, rss: 123 }) }));
  const code = (await (await call("/gateway/admin/invites", "POST", { days: 2 }, admin)).json()).code;
  expect((await call("/gateway/admin/invites/" + code, "DELETE", {}, admin)).status).toBe(204);
  expect(await (await call("/gateway/admin/invites", "GET", undefined, admin)).json()).toContainEqual(expect.objectContaining({ code, revoked: true }));
  expect((await call(endpoint, "PATCH", { disabled: true, password: "newpassword" }, admin)).status).toBe(200);
  expect((await call("/gateway/me", "GET", undefined, cookie)).status).toBe(401);
  expect((await call("/gateway/login", "POST", { username: user.username, password: "newpassword" })).status).toBe(401);
  expect((await call(endpoint, "PATCH", { disabled: false, role: "admin" }, admin)).status).toBe(200);
  const promoted = await login(user.username, "newpassword");
  expect(await (await call("/instance", "GET", undefined, promoted)).json()).toMatchObject({ id: user.id, role: "user" });
  expect((await call("/gateway/admin/users", "GET", undefined, promoted)).status).toBe(200);
  const password = "incorrect";
  for (let i = 0; i < 10; i++) expect((await call("/gateway/login", "POST", { username: "nobody", password }, "", { "X-Real-IP": "192.0.2.1" })).status).toBe(401);
  expect((await call("/gateway/login", "POST", { username: "nobody", password }, "", { "X-Real-IP": "192.0.2.2" })).status).toBe(429);
}, 15_000);

async function wsEcho(url: string, headers: Record<string, string>) {
  // Node's built-in client also accepts request headers in its second argument.
  const NodeWebSocket = WebSocket as typeof WebSocket & (new(url: string, init: { headers: Record<string, string> }) => WebSocket);
  const ws = new NodeWebSocket(url.replace("http:", "ws:"), { headers });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Upgrade rejected"));
  });
  try {
    for (const text of ["first", "second"]) {
      ws.send(text);
      const data = await new Promise(resolve => { ws.onmessage = e => resolve(e.data); });
      expect(data).toBe(text);
    }
  } finally { ws.close(); }
}

test("HTTP, incremental SSE, session and node WebSocket proxying and child recovery", async () => {
  const { call, login, register, dir, base } = await fixture();
  const admin = await login("admin", "password");
  const user = await register(admin, "roommate"), cookie = await login(user.username, "password");
  const spoof = { "X-Alter-Gateway-Secret": "forged", "X-Alter-User": "forged", "X-Alter-Username": "forged" };
  const result = await (await call("/echo?a=b", "POST", { hello: 42 }, cookie + "; theme=dark; alter_session_12=private", spoof)).json();
  expect(result).toMatchObject({ url: "/echo?a=b", method: "POST", body: '{"hello":42}', data: join(dir, user.id),
    headers: { cookie: "theme=dark", "x-alter-user": user.id, "x-alter-username": user.username } });
  expect(result.headers["x-alter-gateway-secret"]).toMatch(/^[0-9a-f]{64}$/);
  const nodeHeader = { Authorization: "Bearer " + user.id + ".fixture" };
  expect((await call("/api/node/connect", "GET", undefined, admin)).status).toBe(401);
  expect(await (await call("/api/node/connect", "GET", undefined, admin, nodeHeader)).json()).toMatchObject({
    id: user.id, headers: { authorization: nodeHeader.Authorization },
  });
  await wsEcho(base + "/socket", { cookie, ...spoof });
  await wsEcho(base + "/api/node/connect", { authorization: "Bearer " + user.id + ".fixture", cookie: admin, ...spoof });
  await expect(wsEcho(base + "/api/node/connect", { authorization: "Bearer " + user.id + ".wrong" })).rejects.toThrow(/rejected/);
  await expect(wsEcho(base + "/api/node/connect", { cookie: admin })).rejects.toThrow(/rejected/);
  const sse = await call("/events", "GET", undefined, cookie);
  const reader = sse.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
  expect((await call("/gateway/logout", "POST", {}, cookie)).status).toBe(204);
  await expect(reader.read()).rejects.toThrow();
  const next = await login(user.username, "password");
  await call("/crash", "GET", undefined, next);
  await expect.poll(async () => {
    const listing = await (await call("/gateway/admin/users", "GET", undefined, admin)).json();
    return listing.find((u: User) => u.id === user.id).instance.status;
  }).toBe("running");

  await expect.poll(async () => {
    const r = await call("/pid", "GET", undefined, next);
    return r.ok ? (await r.json()).pid : result.pid;
  }).not.toBe(result.pid);
  expect((await call("/gateway/admin/users/" + user.id + "/restart", "POST", {}, admin)).status).toBe(204);
}, 15_000);

test("production gateway starts a real restricted server, reopens accounts and retains the shared secret", async () => {
  const dir = await temp(), adminPort = await adminServer();
  const port = await unusedPort(), childPort = await twoInstancePorts();
  const env = { ALTER_GATEWAY_DATA: join(dir, "gateway"), ALTER_GATEWAY_PORT: String(port), ALTER_INSTANCE_BASE_PORT: String(childPort),
    ALTER_ADMIN_INSTANCE: "http://127.0.0.1:" + adminPort, ALTER_WEB_PASSWORD: "password", ALTER_HEARTBEAT: "off",
    ALTER_LLM_BASE_URL: "http://127.0.0.1:" + adminPort + "/v1", ALTER_LLM_API_KEY: "fake", ALTER_MAIN_MODEL: "offline/main", ALTER_TASK_MODEL: "offline/task" };
  let web = await openGateway(env);
  cleanup.push(() => web.close());
  const { call, login, register } = client(port);
  const admin = await login("admin", "password");
  const user = await register(admin, "roommate"), cookie = await login(user.username, "password");
  const service = await call("/api/service", "GET", undefined, cookie);
  expect(service.status).toBe(200);
  expect(await service.json()).toMatchObject({ supported: false, restrictedCapabilities: ["browser", "adapters", "ext-plugins", "cli", "feishu", "service"] });
  expect((await fetch("http://127.0.0.1:" + childPort + "/")).status).toBe(401);
  expect((await fetch("http://127.0.0.1:" + childPort + "/api/state", { headers: { "X-Alter-Gateway-Secret": "wrong", cookie } })).status).toBe(401);
  for (const path of ["/api/login", "/api/logout"]) expect((await call(path, "POST", {}, cookie)).status).toBe(404);
  for (const path of ["/api/adapters/presets", "/api/ext-plugins", "/api/plugins/browser/check", "/api/plugins/cli-local/check",
    "/api/feishu", "/api/plugins/feishu/guide", "/api/feishu/oauth/callback"]) {
    expect((await call(path, "GET", undefined, cookie)).status).toBe(403);
  }
  expect((await call("/api/service", "PUT", { autostart: true }, cookie)).status).toBe(403);
  const plugins = await (await call("/api/plugins", "GET", undefined, cookie)).json();
  expect(plugins.map((p: { id: string }) => p.id).sort()).toEqual(["calendar", "mail", "sources"]);
  const server = "http://127.0.0.1:" + port;
  const { id, token } = await (await call("/api/nodes", "POST", { name: "Laptop" }, cookie)).json();
  const node = fork(join(import.meta.dirname, "fixtures/adapter-node.mjs"), [], { execArgv: [] });
  const ended = once(node, "exit");
  cleanup.push(async () => { if (node.connected) node.disconnect(); await ended; });
  node.send({ server, token, dir: join(dir, "laptop") });
  const root = "/api/nodes/" + id + "/adapters";
  await expect.poll(async () => (await (await call(root, "GET", undefined, cookie)).json()).online, { timeout: 5000 }).toBe(true);
  expect(await (await call("/api/nodes/adapter-presets", "GET", undefined, cookie)).json()).toMatchObject([{ id: "github" }]);
  const value = "node-only-example-secret";
  const payload = { id: "echo", name: "Echo", kind: "cli", config: { command: process.execPath, help: "echo",
    env: { TOKEN: "{{secret:TOKEN}}" } }, secrets: { TOKEN: value } };
  const result = await call(root, "POST", payload, cookie);
  expect(result.status).toBe(201);
  const summary = await result.json();
  expect(summary).toMatchObject({ id: "echo", state: "ok", capabilityId: expect.stringMatching(/^node-/) });
  expect(summary).not.toHaveProperty("config");
  expect(JSON.stringify(summary)).not.toContain(value);
  expect(await (await call(root, "GET", undefined, cookie)).json()).toMatchObject({ online: true, adapters: [summary] });
  expect((await call(root + "/presets/github", "POST", { auth: "invalid" }, cookie)).status).toBe(400);
  expect((await call(root + "/presets/absent", "POST", {}, cookie)).status).toBe(404);
  expect((await call(root + "/echo/refresh", "POST", {}, cookie)).status).toBe(200);
  expect(await (await call(root + "/echo", "PATCH", { enabled: false }, cookie)).json()).toMatchObject({ state: "off" });
  const other = await register(admin, "neighbor"), otherCookie = await login(other.username, "password");
  expect((await call(root, "GET", undefined, otherCookie)).status).toBe(404);
  expect((await call(root + "/echo", "DELETE", {}, otherCookie)).status).toBe(404);
  expect((await call(root + "/echo", "DELETE", {}, cookie)).status).toBe(204);
  expect((await call(root + "/echo", "DELETE", {}, cookie)).status).toBe(404);
  node.disconnect(); await ended;
  const brain = join(dir, "users", user.id);
  const files = await readdir(brain, { withFileTypes: true, recursive: true });
  expect(files.map(f => f.name)).not.toContain("adapters.json");
  for (const f of files.filter(f => f.isFile())) expect((await readFile(join(f.parentPath, f.name))).includes(Buffer.from(value))).toBe(false);
  const secretPath = join(env.ALTER_GATEWAY_DATA, "secret");
  const secret = await readFile(secretPath, "utf8");
  expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
  expect((await stat(join(dir, "users", user.id, "main.sqlite"))).isFile()).toBe(true);
  await web.close();
  await expect(fetch("http://127.0.0.1:" + childPort + "/api/state")).rejects.toThrow();
  web = await openGateway(env);
  expect(await readFile(secretPath, "utf8")).toBe(secret);
  expect(await (await call("/gateway/me", "GET", undefined, cookie)).json()).toEqual(user);
  expect((await call("/api/state", "GET", undefined, cookie)).status).toBe(200);
}, 30_000);
