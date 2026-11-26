import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openRuntime } from "../src/index.ts";
import { gate, fixture, manifest } from "./fixtures.ts";

it("runs commands, uses the filesystem and fetches directly with only the allowed environment", async () => {
  const { data, pkg, write } = fixture();
  const { network: _network, ...declaration } = manifest;
  write({ ...declaration, secrets: [{ name: "lang", purpose: "test name collision" }] });
  const marker = join(data, "result.txt");
  writeFileSync(join(pkg, "index.mjs"), `
    import { execFileSync } from "node:child_process";
    import { writeFileSync } from "node:fs";
    export default { tools: { async read({url, marker, leak}, ctx) {
      const token = await ctx.secrets.get("lang");
      if (leak) return { nested: token };
      const echo = process.platform === "win32"
        ? execFileSync(process.execPath, ["-p", "'echo ok'"], {encoding:"utf8"})
        : execFileSync("/bin/echo", ["echo ok"], {encoding:"utf8"});
      const denied = await Promise.allSettled([
        ctx.secrets.get("undeclared"), ctx.kv.set("x", token), ctx.borrow("notes_read", { token }), ctx.log(token),
      ]);
      const inherited = execFileSync(process.execPath, ["-p", "process.env.LANG || 'absent'"], {encoding:"utf8"}).trim();
      const body = await (await fetch(url, { headers: { Authorization: "Bearer " + token } })).text();
      writeFileSync(marker, body);
      return {denied:denied.map(r => r.status), declared:await ctx.secrets.list(), inherited, echo:echo.trim(), path:process.env.PATH, keys:Object.keys(process.env)};
    } } };
  `);
  const server = createServer((req, res) => res.end(req.headers.authorization === "Bearer declared-test-credential" ? "local fixture" : "unauthorized"));
  const runtime = openRuntime(data, { notify: async () => {}, emit: async () => {}, changed() {},
    secrets: () => ({ lang: "declared-test-credential" }) });
  vi.stubEnv("ALTER_TEST_SECRET", "host-only-test-value");
  vi.stubEnv("LANG", "en_US.UTF-8");
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP port");
    const { sha } = await runtime.store.propose(pkg);
    await runtime.store.approve("sample", sha);
    const result = await runtime.invoke("sample", sha, { kind: "tools", name: "read",
      args: { url: "http://127.0.0.1:" + address.port, marker } });
    expect(result).toMatchObject({ echo: "echo ok", path: process.env.PATH, inherited: "absent",
      declared: ["lang"], denied: Array(4).fill("rejected") });
    await expect(runtime.invoke("sample", sha, { kind: "tools", name: "read", args: { leak: true } })).rejects.toThrow("Credential withheld");
    const audit = readFileSync(join(runtime.store.root, "audit.jsonl"), "utf8");
    expect(audit).toContain('"secret":"lang","caller":"read"');
    expect(audit).toContain('"secret":"undeclared"');
    expect(audit).not.toContain("declared-test-credential");
    expect(runtime.store.active("sample")!.kv).toEqual({});
    expect(result).toHaveProperty("keys");
    const { keys } = result as { keys: string[] };
    expect(keys.map(k => k.toUpperCase())).not.toContain("ALTER_TEST_SECRET");
    expect(keys.map(k => k.toUpperCase())).not.toContain("LANG");
    expect(readFileSync(marker, "utf8")).toBe("local fixture");
  } finally {
    vi.unstubAllEnvs();
    server.closeAllConnections(); server.close();
    await runtime.close();
  }
});

it("initializes once, scopes concurrent RPCs and cancellation, and closes on stop and runtime shutdown", async () => {
  const f = fixture(), marker = join(f.data, "lifecycle.jsonl");
  writeFileSync(join(f.pkg, "index.mjs"), `
    import { appendFileSync } from "node:fs";
    const mark = event => appendFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, event]) + "\\n");
    let context;
    export default {
      async init(ctx) { context = ctx; await ctx.log("init"); mark("init"); },
      close() { mark("close"); },
      tools: { async read({ borrow }) {
        return borrow ? await context.borrow("notes_read", {}) : process.pid;
      } }
    };
  `);
  const runtime = openRuntime(f.data, { secrets: () => ({}), async notify() {}, async emit() {}, changed() {} });
  const { sha } = await runtime.store.propose(f.pkg);
  await runtime.store.approve("sample", sha);
  const invoke = (borrow?: () => Promise<unknown>, signal?: AbortSignal) => runtime.invoke("sample", sha,
    { kind: "tools", name: "read", args: { borrow: !!borrow } }, borrow && { borrow, signal });
  const entered = gate(), pending = gate();
  const ctrl = new AbortController();
  try {
    const slow = invoke(async () => { entered.resolve(); await pending.promise; return "late"; }, ctrl.signal);
    const pid = await invoke();
    await entered.promise;
    expect(await invoke(async () => "other caller")).toBe("other caller");
    ctrl.abort();
    await expect(slow).rejects.toThrow("stopped");
    expect(await invoke()).toBe(pid);
    await runtime.stop("sample");
    const next = await invoke();
    expect(next).not.toBe(pid);
    await runtime.close();
    expect(readFileSync(marker, "utf8").trim().split("\n").map(row => JSON.parse(row)))
      .toEqual([[pid, "init"], [pid, "close"], [next, "init"], [next, "close"]]);
  } finally { pending.resolve(); await runtime.close(); }
});

it("rejects all outstanding calls on timeout or crash, and starts a fresh process on demand", async () => {
  const f = fixture();
  f.write({ ...manifest, resources: { ...manifest.resources, timeoutMs: 800 } });
  writeFileSync(join(f.pkg, "index.mjs"), `
    export default { tools: { read({ action }) {
      if (action === "hang") return new Promise(() => {});
      if (action === "crash") process.exit(3);
      return process.pid;
    } } };
  `);
  const runtime = openRuntime(f.data, { secrets: () => ({}), async notify() {}, async emit() {}, changed() {} });
  const { sha } = await runtime.store.propose(f.pkg);
  await runtime.store.approve("sample", sha);
  const invoke = (action: string) => runtime.invoke("sample", sha, { kind: "tools", name: "read", args: { action } });
  try {
    const first = await invoke("pid");
    const timed = invoke("hang");
    expect(await invoke("pid")).toBe(first);
    await Promise.all([expect(timed).rejects.toThrow("timeout"), expect(invoke("hang")).rejects.toThrow("reset")]);
    expect(runtime.store.view("sample").failures).toBe(1);
    const second = await invoke("pid");
    expect(second).not.toBe(first);
    await Promise.all([expect(invoke("hang")).rejects.toThrow("exited"), expect(invoke("crash")).rejects.toThrow("exited")]);
    expect(await invoke("pid")).not.toBe(second);
  } finally { await runtime.close(); }
});

it("releases a loaded version on upgrade, rollback and tool circuit break", async () => {
  const f = fixture(), marker = join(f.data, "closed");
  const code = (version: number) => `
    import { appendFileSync } from "node:fs";
    export default {
      tools: { read({ fail }) { if (fail) throw new Error(); return [${version}, process.pid]; } },
      close() { appendFileSync(${JSON.stringify(marker)}, String(process.pid) + "\\n"); }
    };
  `;
  writeFileSync(join(f.pkg, "index.mjs"), code(1));
  const runtime = openRuntime(f.data, { secrets: () => ({}), async notify() {}, async emit() {}, changed() {} });
  async function approve() {
    const { sha } = await runtime.store.propose(f.pkg);
    await runtime.store.approve("sample", sha);
    return sha;
  }
  const read = (sha: string, fail = false) => runtime.invoke("sample", sha, { kind: "tools", name: "read", args: { fail } }) as Promise<number[]>;
  try {
    const v1 = await approve();
    const [one, first] = await read(v1);
    writeFileSync(join(f.pkg, "index.mjs"), code(2));
    const v2 = await approve();
    const [two, second] = await read(v2);
    runtime.store.rollback("sample", v1);
    const [rolledBack, third] = await read(v1);
    expect([one, two, rolledBack]).toEqual([1, 2, 1]);
    expect(new Set([first, second, third]).size).toBe(3);
    for (let i = 0; i < 5; i++) await expect(read(v1, true)).rejects.toThrow("Plugin invocation failed");
    expect(runtime.store.view("sample").status).toBe("paused");
    await runtime.stop("sample");
    expect(readFileSync(marker, "utf8").trim().split("\n").map(Number)).toEqual([first, second, third]);
  } finally { await runtime.close(); }
});

it("resolves an unconfigured declared secret to undefined and discards cached credentials on rotation", async () => {
  const f = fixture();
  writeFileSync(join(f.pkg, "index.mjs"), `
    let token;
    export default { async init(ctx) { token = await ctx.secrets.get("token"); },
      tools: { read() { return { pid: process.pid, missing: token === undefined }; } }
    };
  `);
  let configured: Record<string, string> = {};
  const runtime = openRuntime(f.data, { secrets: () => configured, async notify() {}, async emit() {}, changed() {} });
  const { sha } = await runtime.store.propose(f.pkg);
  await runtime.store.approve("sample", sha);
  const read = () => runtime.invoke("sample", sha, { kind: "tools", name: "read", args: {} }) as Promise<{ pid: number; missing: boolean }>;
  try {
    const a = await read();
    expect(a.missing).toBe(true);
    configured = { token: "first-credential" };
    const b = await read();
    expect(b.missing).toBe(false);
    expect(b.pid).not.toBe(a.pid);
    expect(await read()).toEqual(b);
    configured.token = "rotated-credential";
    expect((await read()).pid).not.toBe(b.pid);
  } finally { await runtime.close(); }
});

it("reaps a worker even if the close hook blocks its event loop", async () => {
  const f = fixture(), marker = join(f.data, "closing");
  writeFileSync(join(f.pkg, "index.mjs"), `
    import { writeFileSync } from "node:fs";
    export default { tools: { read: () => process.pid },
      close() { writeFileSync(${JSON.stringify(marker)}, "entered"); for (;;) {} } };
  `);
  const runtime = openRuntime(f.data, { secrets: () => ({}), async notify() {}, async emit() {}, changed() {} });
  const { sha } = await runtime.store.propose(f.pkg);
  await runtime.store.approve("sample", sha);
  const pid = await runtime.invoke("sample", sha, { kind: "tools", name: "read", args: {} }) as number;
  await runtime.close();
  expect(readFileSync(marker, "utf8")).toBe("entered");
  expect(() => process.kill(pid, 0)).toThrow();
});
