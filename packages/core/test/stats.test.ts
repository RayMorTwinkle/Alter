import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, expect, it } from "vitest";
import { approvalStats, Reviews } from "../src/broker.ts";
import { openAlter } from "../src/main.ts";
import { context, MemoryStorage, ROOT_CONVERSATION_ID, type TaskId } from "../src/runtime.ts";
import { submitMessage } from "../src/timeline.ts";
import { Tasks } from "../src/state.ts";
import { stats } from "../src/stats.ts";
import { appendUsage, readUsage, usageSummary, type UsageLine } from "../src/usage.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const at = "2026-03-09T03:30:00Z"; // March 8, 23:30 EDT, after the spring-forward.
const base = { at, model: "model", attempt: 1, outcome: "ok", latencyMs: 10 } as const;
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "alter-stats-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const app = await openAlter(new MemoryStorage(), createModels(), { provider: "unused", modelId: "unused" }, undefined, {},
    { now: () => Date.parse(at) });
  cleanups.push(app.close);
  const query = (range: Parameters<typeof stats>[0], zone = "America/New_York") => stats(range, zone, { app, dir });
  return { app, dir, query };
}

it("reads legacy lines without guessing cache splits, charges or wake IDs", async () => {
  const { dir, query } = await setup();
  const line = { ...base, conversation: "task", proactive: true, inputTokens: 20, outputTokens: 3, fallbackFrom: "primary" };
  await writeFile(join(dir, "usage.jsonl"), JSON.stringify(line) + "\n");
  expect(await readUsage(dir)).toMatchObject([{ role: "goal", fallback: true, costUsd: null }]);
  expect(await query("day")).toMatchObject({ total: { calls: 1, tokens: 23, costUsd: null, cacheHitRate: null, fallbacks: 1 },
    byRole: [{ role: "goal" }], wakes: { count: 0 } });
  expect(await usageSummary(dir)).toEqual([{ model: "model", calls: 1, failureRate: "0.0%", aborted: 0, fallbacks: 1,
    inputTokens: 20, outputTokens: 3, p50Ms: 10, p95Ms: 10 }]);
});

it("weights cache hits by token count and freezes known prices on each row", async () => {
  const { dir, query } = await setup();
  const line: UsageLine = { ...base, role: "judge", input: 5, cacheRead: 10, cacheWrite: 5, outputTokens: 4 };
  // Synthetic USD per million tokens, used only in this fixture.
  await writeFile(join(dir, "prices.json"), JSON.stringify({ model: { input: 2, cacheRead: 1, cacheWrite: 4, output: 10 } }));
  await appendUsage(dir, line);
  await appendUsage(dir, { ...line, input: 80, cacheRead: 0, cacheWrite: 0, outputTokens: 0 });
  await rm(join(dir, "prices.json"));
  const priced = await query("day");
  expect(priced.total.costUsd).toBeCloseTo(0.00024, 10);
  expect(priced.total).toMatchObject({ input: 85, cacheRead: 10, cacheWrite: 5, output: 4, tokens: 104, cacheHitRate: 0.1 });
  expect(priced.byRole[0]).toEqual({ role: "judge", ...priced.total });
  expect(priced.byModel[0]).toEqual({ model: "model", ...priced.total });
  await appendUsage(dir, { ...line, model: "other", role: "new-role" });
  expect((await readUsage(dir)).at(-1)?.costUsd).toBe(null);
  expect((await query("all")).total.costUsd).toBe(null);
});

it("uses inclusive local midnights and nearest-rank latencies for the selected attempts", async () => {
  const { dir, query } = await setup();
  for (const [date, ms] of [
    ["2026-02-06T05:00Z", 999], ["2026-02-07T05:00Z", 900], ["2026-03-02T04:59Z", 110], ["2026-03-02T05:00Z", 100],
    ["2026-03-08T04:59:59.999Z", 80], ["2026-03-08T05:00Z", 10], ["2026-03-09T00:30Z", 50], [at, 30],
    ["2026-03-09T03:30:00.001Z", 999],
  ] as const) {
    await appendUsage(dir, { ...base, role: "watch", at: new Date(date).toISOString(), latencyMs: ms,
      firstTokenMs: ms === 10 ? undefined : ms / 2 });
  }
  const today = await query("day");
  expect(today).toMatchObject({ total: { calls: 3 }, daily: [{ date: "2026-03-08" }], latency: {
    total: { samples: 3, p50Ms: 30, p95Ms: 50 }, firstToken: { samples: 2, p50Ms: 15, p95Ms: 25 } } });
  expect((await query("day", "UTC")).total.calls).toBe(2);
  for (const [range, calls, days] of [["7d", 5, 7], ["30d", 7, 30], ["all", 8, 31]] as const) {
    const result = await query(range);
    expect(result.total.calls).toBe(calls);
    expect(result.daily).toHaveLength(days);
    expect(result.daily.reduce((total, d) => total + d.usage.calls, 0)).toBe(calls);
    expect(result.daily.some(d => d.usage.calls === 0)).toBe(true);
  }
});

it("ranks only priced tasks, keeps continued tasks separate and excludes running tasks from success rate", async () => {
  const { app, dir, query } = await setup();
  const createdAt = Date.parse(at) - 3000;
  await app.main.commit(async tx => {
    const { byId } = await tx.doc(Tasks, app.main.id);
    for (let i = 0; i < 13; i++) byId["t" + i] = { brief: "test", conversationId: ROOT_CONVERSATION_ID,
      worker: 1 as TaskId, thinking: "high", context: "fresh", permission: "full", createdAt, ...(i === 1 && { continuedFrom: "t0" }),
      status: i === 0 ? "failed" : i === 1 ? "running" : "completed" };
  }, context);
  for (let i = 0; i < 13; i++) await appendUsage(dir, { ...base, role: "task", taskId: "t" + i, costUsd: i === 12 ? null : i });
  const result = await query("all");
  expect(result.tasks).toMatchObject({ count: 13, completed: 11, terminal: 12, successRate: 11 / 12 });
  expect(result.tasks.items.find(t => t.taskId === "t1")).toMatchObject({ continuedFrom: "t0", rounds: 1, durationMs: 3000 });
  expect(result.topTasks.map(t => t.costUsd)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
});

it("streams multi-megabyte JSONL across UTF-8 chunk boundaries and picks up later appends", async () => {
  const { dir, query } = await setup();
  const path = join(dir, "usage.jsonl");
  const row = JSON.stringify({ ...base, model: "统计".repeat(400), role: "heartbeat", input: 1, cacheRead: 0, cacheWrite: 0 });
  await writeFile(path, (row + "\n").repeat(1800) + '{"at":');
  expect((await query("day")).total.calls).toBe(1800);
  await appendFile(path, JSON.stringify({ ...base, role: "triage" }).slice('{"at":'.length) + "\n");
  expect((await query("day")).total.calls).toBe(1801);
});

it("counts a real wake even when generation ends before contacting a model", async () => {
  const { app, query } = await setup();
  await submitMessage(app.main, "hello", "feishu");
  await app.main.waitForIdle(context);
  const result = await query("day");
  expect(result.wakes).toMatchObject({ count: 1, bySource: { "user-feishu": 1 }, items: [{ usage: { calls: 0 } }] });
  expect(result.total.calls).toBe(0);
});

it("dates user and judge events independently and includes undated v1.10 reviews only in all-time stats", async () => {
  const { app, query } = await setup();
  const today = Date.parse(at), yesterday = today - 86_400_000;
  const judgment = { inScope: true, reason: "ok" };
  await app.main.commit(async tx => {
    const { byId } = await tx.doc(Reviews, app.main.id);
    byId.old = { user: "deny", judgment };
    byId.split = { user: "task-full", userAt: yesterday, judgment, judgedAt: today };
    byId.late = { timeoutAt: yesterday, user: "once", userAt: today };
  }, context);
  const { approvals } = await query("day");
  expect(approvals).toMatchObject({ userDecisions: { once: 1, "task-full": 0, deny: 0 }, judgments: { inScope: 1 }, timeouts: 0,
    shadow: { compared: 1, agreed: 1, agreementRate: 1 } });
  const all = (await query("all")).approvals;
  expect(all.shadow).toEqual(await approvalStats(app.main));
  expect(all).toMatchObject({ timeouts: 1, shadowAgreementRate: 0.5, shadow: { deniedButInScope: 1 } });
});
