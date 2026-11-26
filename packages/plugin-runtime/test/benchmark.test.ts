import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openRuntime } from "../src/index.ts";
import { run } from "../src/process.ts";
import { gate, fixture } from "./fixtures.ts";

it("measures 20 cold versus 1 cold + 19 warm calls, and a tool during a blocked source", async () => {
  const f = fixture();
  writeFileSync(join(f.pkg, "index.mjs"), `
    let calls = 0;
    export default {
      tools: { read() { return { pid: process.pid, calls: ++calls }; } },
      sources: { async feed(ctx) { await ctx.borrow("notes_read", {}); return []; } }
    };
  `);
  const entered = gate(), release = gate();
  const host = { secrets: () => ({}), async emit() {}, async notify() {}, changed() {},
    async borrowSource() { entered.resolve(); await release.promise; return null; } };
  const cold = openRuntime(f.data, host, { run });
  const { sha } = await cold.store.propose(f.pkg);
  await cold.store.approve("sample", sha);
  const warm = openRuntime(f.data, host);
  function tool(runtime: typeof warm) {
    return runtime.invoke("sample", sha, { kind: "tools", name: "read", args: {} }) as Promise<{ pid: number; calls: number }>;
  }
  async function measure(runtime: typeof warm) {
    const samples = [], results = [];
    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      const at = performance.now();
      results.push(await tool(runtime));
      samples.push(performance.now() - at);
    }
    const total = performance.now() - start;
    const sorted = samples.toSorted((a, b) => a - b);
    const mean = samples.reduce((sum, n) => sum + n, 0) / samples.length;
    return { results, ms: { total, first: samples[0], p50: (sorted[9]! + sorted[10]!) / 2, mean } };
  }
  try {
    // Prime the parent process's SDK type stripping once for both transports.
    await tool(cold);
    const a = await measure(cold), b = await measure(warm);
    expect(a.results.every(r => r.calls === 1)).toBe(true);
    expect(new Set(b.results.map(r => r.pid)).size).toBe(1);
    expect(b.results.map(r => r.calls)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const poll = warm.invoke("sample", sha, { kind: "sources", name: "feed", args: null });
    try {
      await Promise.race([entered.promise, poll.then(() => { throw new Error("Source did not enter borrow"); })]);
      const at = performance.now();
      const overlap = await tool(warm);
      const concurrentToolMs = performance.now() - at;
      expect(overlap).toEqual({ pid: b.results[0]!.pid, calls: 21 });
      console.info("Runtime benchmark (ms)", JSON.stringify({ cold: a.ms, persistent: b.ms, concurrentToolMs }));
    } finally { release.resolve(); await poll; }
  } finally { await Promise.all([cold.close(), warm.close()]); }
}, 30_000);
