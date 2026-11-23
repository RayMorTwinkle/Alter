import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openRuntime } from "../src/index.ts";
import { parseManifest } from "../src/manifest.ts";
import type { run } from "../src/process.ts";
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
  next.version = "2"; next.tools[0]!.effect = "external-send"; next.network[0]!.pathPrefixes.push("/new");
  next.network.push({ host: "new.example", methods: ["POST"], pathPrefixes: ["/x"] });
  next.secrets.push({ name: "extra", purpose: "test" }); next.borrows.push("calendar_list");
  f.write(next);
  const p = await f.r.store.propose(f.pkg);
  expect(p.expanded.join(" ")).toMatch(/external-send.*\/new.*new.example.*extra.*calendar_list/);
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
  const caller = { tainted:async () => false, mark:async () => {}, borrow };
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
