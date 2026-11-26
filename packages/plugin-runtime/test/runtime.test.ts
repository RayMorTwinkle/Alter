import { chmodSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openRuntime } from "../src/index.ts";
import { parseManifest } from "../src/manifest.ts";
import type { run } from "../src/process.ts";
import { preparePackage } from "../src/packages.ts";
import { openStore } from "../src/store.ts";
import { fixture, manifest } from "./fixtures.ts";

async function setup(worker: typeof run) {
  const f = fixture();
  const notify = vi.fn(async () => {}), emit = vi.fn(async () => {});
  const r = openRuntime(f.data, { secrets: () => ({ token: "test-secret" }), emit, notify, changed: () => {} }, { run: worker });
  const p = await r.store.propose(f.pkg);
  const tool = () => r.invoke("sample", p.sha, { kind: "tools", name: "read", args: {} });
  const poll = () => r.invoke("sample", p.sha, { kind: "sources", name: "feed", args: null });
  return { ...f, r, notify, emit, p, tool, poll, approve: () => r.store.approve("sample", p.sha) };
}
it("rejects unknown fields and malformed optional declarations", () => {
  for (const patch of [{ no: 0 }, { sources: [{ ...manifest.sources[0], extra: true }] }, { network: [{ ...manifest.network[0], methods: ["?"] }] }, { requires: [""] },
  { resources: { ...manifest.resources, workers: 5 } }, { tools: [{ ...manifest.tools[0], inputSchema: { type: "object", unknown: true } }] }])
    expect(() => parseManifest({ ...manifest, ...patch })).toThrow();
});
it("ties approval and every startup to package bytes and never runs an unapproved version", async () => {
  const worker = vi.fn(async () => "ok");
  const f = await setup(worker);
  await expect(f.tool()).rejects.toThrow(); expect(worker).not.toHaveBeenCalled();
  await expect(f.r.store.approve("sample", "wrong")).rejects.toThrow();
  writeFileSync(join(f.pkg, "index.mjs"), "export default {tools:{}}");
  await expect(f.approve()).rejects.toThrow("mismatch");
  writeFileSync(join(f.pkg, "index.mjs"), "export default {}"); await f.approve();
  const path = join(f.r.store.directory(f.p.sha), "index.mjs");
  chmodSync(path, 0o600); writeFileSync(path, "changed");
  await expect(f.tool()).rejects.toThrow("integrity");
  expect(worker).not.toHaveBeenCalled(); expect(f.r.store.view("sample").status).toBe("quarantined");
  symlinkSync(path, join(f.pkg, "linked.js"));
  await expect(f.r.store.propose(f.pkg)).rejects.toThrow("link");
});
it("compares upgrades and restores the previous code, KV and feed cursor after restart", async () => {
  const f = await setup(async (_, __, call, host) => {
    if (call.kind === "sources") return [{ id: "before", title: "before" }];
    return host("kv.set", { key: "x", value: "before" });
  });
  await f.approve(); await f.tool(); await f.poll();
  const next = structuredClone(manifest);
  next.version = "2"; next.tools[0]!.effect = "write"; next.network[0]!.pathPrefixes.push("/new");
  next.network.push({ host: "new.example", methods: ["POST"], pathPrefixes: ["/x"] });
  next.secrets.push({ name: "extra", purpose: "test" }); next.borrows.push("calendar_list");
  f.write(next);
  const p = await f.r.store.propose(f.pkg);
  expect(p.expanded.join(" ")).toMatch(/write.*\/new.*new.example.*extra.*calendar_list/);
  await f.r.store.approve("sample", p.sha); f.r.store.update("sample", p.sha, v => { v.kv.x = "after"; v.sources = {}; });
  const store = openStore(f.data);
  store.rollback("sample");
  expect(store.active("sample")).toMatchObject({ sha: f.p.sha, kv: { x: "before" }, manifest: { version: "1" } });
  expect(store.active("sample")!.sources.feed?.seen).toHaveLength(1);
});
it("keeps the plugin enabled when it handles an HTTP proxy refusal", async () => {
  const f = await setup(async (_, __, ___, host, signal) => {
    await expect(host("http.request", { method: "GET", url: "http://127.0.0.1/" })).rejects.toThrow("Forbidden URL");
    expect(signal.aborted).toBe(false);
    return "ok";
  });
  await f.approve();
  await expect(f.tool()).resolves.toBe("ok");
  expect(f.r.store.view("sample")).toMatchObject({ status: "enabled", failures: 0 });
  expect(f.notify).not.toHaveBeenCalled();
});
it("pauses and notifies after five consecutive failures", async () => {
  const f = await setup(async () => { throw new Error("offline"); }); await f.approve();
  for (let i = 0;i < 5;i++) await expect(f.tool()).rejects.toThrow("offline");
  expect(f.r.store.view("sample")).toMatchObject({ status: "paused", failures: 5 });
  expect(f.notify).toHaveBeenCalledTimes(1);
});
it("baselines and deduplicates external data and pauses only a malformed source", async () => {
  let result: unknown = [{ id: "a", title: "old" }];
  const f = await setup(async () => result); await f.approve();
  await f.poll(); result = [{ id: "b", title: "news" }, { id: "b", title: "news" }]; await f.poll(); await f.poll();
  expect(f.emit).toHaveBeenCalledTimes(1);
  expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ author: "external", untrusted: true, source: "feed:feed", summary: "news" }));
  result = {};
  for (let i = 0;i < 3;i++) await expect(f.poll()).rejects.toThrow("Invalid poll result");
  expect(f.r.store.view("sample")).toMatchObject({ status: "enabled", sources: [{ paused: true, invalid: 3 }] });
});

it("only forwards a declared borrow, validates output and enforces the KV quota", async () => {
  const borrow = vi.fn(async () => "borrowed");
  const caller = { borrow };
  const f = await setup(async (_,__,___,host) => {
    await expect(host("borrow",{tool:"undeclared",args:{}})).rejects.toThrow("Undeclared");
    await expect(host("kv.set",{key:"x",value:"x".repeat(4096)})).rejects.toThrow("quota");
    expect(await host("kv.list",{})).toEqual([]);
    return host("borrow",{tool:"notes_read",args:{id:"welcome"}});
  });
  const next = structuredClone(manifest);
  next.tools[0]!.outputSchema = {type:"integer"};
  f.write(next);
  const p = await f.r.store.propose(f.pkg);
  await f.r.store.approve("sample",p.sha);
  await expect(f.r.invoke("sample",p.sha,{kind:"tools",name:"read",args:{}},caller)).rejects.toThrow("Invalid tool output");
  expect(borrow).toHaveBeenCalledExactlyOnceWith("notes_read",{id:"welcome"},"read",expect.any(AbortSignal));
});

it.each(["write-local", "external-send"])("migrates an installed %s package without changing its approved bytes", async effect => {
  const f = fixture();
  const legacy = { ...manifest, tools: [{ ...manifest.tools[0], effect }] };
  const bytes = JSON.stringify(legacy);
  writeFileSync(join(f.pkg, "alter-plugin.json"), bytes);
  const store = openStore(f.data);
  await expect(store.propose(f.pkg)).rejects.toThrow("Unsupported effect");

  const p = await preparePackage(store.root, f.pkg, true);
  writeFileSync(join(store.root, "registry.json"), JSON.stringify({ sample: {
    pending: { ...p, manifest: legacy }, versions: [],
  } }));
  const reopened = openStore(f.data);
  expect(reopened.view("sample").pending?.manifest.tools[0]?.effect).toBe("write");
  await reopened.approve("sample", p.sha);
  reopened.update("sample", p.sha, v => Object.assign(v, { manifest: legacy }));
  const installed = openStore(f.data);
  expect(installed.view("sample")).toMatchObject({ active: p.sha, status: "enabled", manifest: { tools: [{ effect: "write" }] } });
  expect(readFileSync(join(installed.directory(p.sha), "alter-plugin.json"), "utf8")).toBe(bytes);
});

it.each(["unknown", "", null, undefined])("rejects an invalid effect at installation (%s)", effect => {
  expect(() => parseManifest({ ...manifest, tools: [{ ...manifest.tools[0], effect }] })).toThrow("Unsupported effect");
});

it("audits declared and denied reads and blocks credential-bearing host requests, results and errors", async () => {
  const borrow = vi.fn(async () => null);
  const f = await setup(async (_, __, call, host) => {
    expect(await host("secrets.list", {})).toEqual(["token"]);
    const token = await host("secrets.get", { name: "token" });
    expect(token).toBe("test-secret");
    await expect(host("secrets.get", { name: "undeclared" })).rejects.toThrow("Undeclared");
    for (const [method, params] of [
      ["kv.set", { key: "k", value: { nested: token } }], ["kv.set", { key: token, value: true }],
      ["borrow", { tool: "notes_read", args: { token } }], ["log", { message: token }],
      ["http.request", { url: "https://example.org/", method: "POST", body: token }],
    ] as const) await expect(host(method, params)).rejects.toThrow("Credential withheld");
    if ((call.args as { fail?: boolean }).fail) throw new Error("broken: " + token);
    return { nested: [token] };
  });
  await f.approve();
  const invoke = (fail: boolean) => f.r.invoke("sample", f.p.sha, { kind: "tools", name: "read", args: { fail } }, { borrow });
  await expect(invoke(false)).rejects.toThrow("Credential withheld");
  await expect(invoke(true)).rejects.toThrow("Plugin invocation failed");
  expect(borrow).not.toHaveBeenCalled();
  expect(f.r.store.active("sample")!.kv).toEqual({});
  const audit = readFileSync(join(f.r.store.root, "audit.jsonl"), "utf8");
  expect(audit).not.toContain("test-secret");
  const reads = audit.trim().split("\n").map(line => JSON.parse(line)).filter(row => row.secret);
  expect(reads).toEqual(["token", "undeclared", "token", "undeclared"]
    .map(secret => ({ plugin: "sample", secret, caller: "read" })));
});

it("keeps overflow history, delivery checkpoints, backoff and tool failures independent across restart", async () => {
  const old = Array.from({ length: 1010 }, (_, i) => ({ id: String(i), title: "old" }));
  let batch = old, offline = false;
  const worker: typeof run = async (_, __, call) => {
    if (call.kind === "tools" || offline) throw new Error("offline");
    return batch;
  };
  const f = await setup(worker);
  await f.approve(); await f.poll();
  expect(f.emit).not.toHaveBeenCalled();
  expect(f.r.store.active("sample")!.sources.feed).toMatchObject({ baseline: true, overflow: { length: 10 } });
  expect(f.r.store.active("sample")!.sources.feed!.seen).toHaveLength(1000);
  await expect(f.tool()).rejects.toThrow("offline");
  batch = [{ id: "a", title: "first" }, ...old, { id: "b", title: "second" }];
  f.emit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("delivery failed"));
  await expect(f.poll()).rejects.toThrow("delivery failed");
  const progress = f.r.store.view("sample").sources[0]!;
  expect(progress).toMatchObject({ todayCount: 1, error: "delivery failed", invalid: 0, nextPollAt: progress.next });
  expect(progress.next - progress.lastPollAt).toBe(120_000);
  await f.r.close();
  const emit = vi.fn(async () => {});
  const runtime = openRuntime(f.data, { emit, notify: f.notify, changed() {}, secrets: () => ({}) }, { run: worker });
  const poll = () => runtime.invoke("sample", f.p.sha, { kind: "sources", name: "feed", args: null });
  await poll();
  expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ summary: "second" }));
  expect(runtime.store.view("sample")).toMatchObject({ failures: 1, sources: [{ todayCount: 2, error: null }] });
  offline = true;
  for (let i = 1; i <= 6; i++) {
    await expect(poll()).rejects.toThrow("offline");
    const s = runtime.store.view("sample").sources[0]!;
    expect(s.next - s.lastPollAt).toBe(60_000 * 2 ** i);
  }
  expect(runtime.store.view("sample")).toMatchObject({ failures: 1, status: "enabled", sources: [{ paused: false, invalid: 0 }] });
  await runtime.close();
});

it("migrates legacy next and seen, including an empty baseline, without replaying old data", async () => {
  const f = await setup(async () => [{ id: "old", title: "old" }]);
  await f.approve(); await f.poll(); await f.r.close();
  const path = join(f.r.store.root, "registry.json"), registry = JSON.parse(readFileSync(path, "utf8"));
  const version = registry.sample.versions[0];
  version.manifest.sources.push({ name: "empty", minIntervalSeconds: 60 });
  version.sources = {
    feed: { seen: version.sources.feed.seen, invalid: 1, paused: false, next: 1234 },
    empty: { seen: [], invalid: 0, paused: false, next: 42 },
  };
  writeFileSync(path, JSON.stringify(registry));
  const runtime = openRuntime(f.data, { emit: f.emit, notify: f.notify, changed() {}, secrets: () => ({}) },
    { run: async () => [{ id: "old", title: "old" }], timeZone: "Asia/Taipei" });
  expect(runtime.store.view("sample").sources[0]).toMatchObject({ invalid: 1, next: 1234, nextPollAt: 1234, lastPollAt: 0, todayCount: 0, error: null });
  for (const name of ["feed", "empty"]) await runtime.invoke("sample", f.p.sha, { kind: "sources", name, args: null });
  expect(f.emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: "feed:empty" }));
  runtime.store.update("sample", f.p.sha, v => { v.sources.empty!.day = "2000-01-01"; });
  expect(runtime.store.view("sample").sources[1]?.todayCount).toBe(0);
  await runtime.close();
});

it("persists each acknowledged delivery before the next and retains the burst summary", async () => {
  let batch: { id: string; title: string }[] = [];
  const f = await setup(async () => batch);
  await f.approve(); await f.poll();
  batch = Array.from({ length: 25 }, (_, i) => ({ id: String(i), title: String(i) }));
  f.emit.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
    const onDisk = openStore(f.data).view("sample").sources[0]!;
    expect(onDisk.todayCount).toBe(1);
  });
  await f.poll(); await f.poll();
  expect(f.emit).toHaveBeenCalledTimes(21);
  expect(f.emit).toHaveBeenLastCalledWith(expect.objectContaining({ summary: "另外 5 条更新" }));
  expect(f.r.store.view("sample").sources[0]?.todayCount).toBe(25);
  await f.r.close();
});
