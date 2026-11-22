import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { raceWithAbortSignal } from "@earendil-works/pi-ai/utils/abort";
import type { calendarTime } from "./calendar-time.ts";
import { dataDirectory, loadRepoEnv } from "./config.ts";

export type UsageLine = {
  at: string;
  conversation: "main" | "task" | "triage";
  proactive?: true;
  model: string;
  attempt: number;
  fallbackFrom?: string;
  outcome: "ok" | "error";
  errorKind?: string;
  latencyMs: number;
  firstTokenMs?: number;
  inputTokens?: number;
  outputTokens?: number;
};

export function appendUsage(dir: string, line: UsageLine) {
  return appendFile(join(dir, "usage.jsonl"), JSON.stringify(line) + "\n", { mode: 0o600 });
}

export async function readUsage(dir: string): Promise<UsageLine[]> {
  let contents: string;
  try {
    contents = await readFile(join(dir, "usage.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return contents.split("\n").filter(Boolean).map(row => JSON.parse(row));
}

export const budgetExhausted = "今日主动预算已用完";
export type ProactiveBudget = ReturnType<typeof createProactiveBudget>;
const tokens = (line: UsageLine) => (line.inputTokens ?? 0) + (line.outputTokens ?? 0);

export function createProactiveBudget(time: ReturnType<typeof calendarTime>, limit: number, now: () => number, dir?: string) {
  let cached: { day: number; balance: Promise<{ used: number }> } | undefined;
  let pending = Promise.resolve();

  async function restore(day: number, end: number) {
    let used = 0;
    for (const line of dir ? await readUsage(dir) : []) {
      if (line.conversation !== "triage" && !line.proactive) continue;
      const at = Date.parse(line.at);
      if (at >= day && at < end) used += tokens(line);
    }
    return { used };
  }
  function today(at: number) {
    const day = time.midnight(at);
    if (cached?.day !== day) {
      const balance = restore(day, time.midnight(at, 1));
      cached = { day, balance };
      balance.catch(() => { if (cached?.balance === balance) cached = undefined; });
    }
    return cached.balance;
  }
  return {
    available: async (at: number) => (await today(at)).used < limit,
    // Serialize model calls so concurrent goals and triage see the preceding call's actual cost.
    async acquire(signal?: AbortSignal) {
      const previous = pending;
      let release!: () => void;
      const done = new Promise<void>(resolve => { release = resolve; });
      pending = previous.then(() => done);
      try {
        await (signal ? raceWithAbortSignal(previous, signal) : previous);
        const at = now();
        const state = await today(at);
        if (state.used >= limit) { release(); return; }
        return { at, release, async record(line: UsageLine) {
          state.used += tokens(line);
          if (dir) await appendUsage(dir, line);
        } };
      } catch (error) { release(); throw error; }
    },
  };
}

export function usageTotals(lines: UsageLine[]) {
  const empty = () => ({ input: 0, output: 0, tokens: 0, calls: 0, aborted: 0 });
  const totals = { main: empty(), task: empty(), triage: empty(), total: empty() };
  for (const line of lines) {
    for (const group of [totals[line.conversation], totals.total]) {
      group.input += line.inputTokens ?? 0;
      group.output += line.outputTokens ?? 0;
      group.tokens = group.input + group.output;
      group.calls++;
      if (line.errorKind === "aborted") group.aborted++;
    }
  }
  return totals;
}

export async function usageSummary(dir: string, conversation?: UsageLine["conversation"]) {
  const models = new Map<string, { latencies: number[]; failures: number; aborted: number; fallbacks: number; inputTokens: number; outputTokens: number }>();
  for (const line of await readUsage(dir)) {
    if (conversation && line.conversation !== conversation) continue;
    const group = models.get(line.model) ?? { latencies: [], failures: 0, aborted: 0, fallbacks: 0, inputTokens: 0, outputTokens: 0 };
    group.latencies.push(line.latencyMs);
    // A user-initiated abort is not a provider failure.
    if (line.errorKind === "aborted") group.aborted++;
    else if (line.outcome === "error") group.failures++;
    if (line.fallbackFrom !== undefined) group.fallbacks++;
    group.inputTokens += line.inputTokens ?? 0;
    group.outputTokens += line.outputTokens ?? 0;
    models.set(line.model, group);
  }
  return Array.from(models, ([model, { latencies, failures, ...totals }]) => {
    latencies.sort((a, b) => a - b);
    const calls = latencies.length;
    const percentile = (fraction: number) => latencies[Math.ceil(fraction * calls) - 1]!;
    return { model, calls, failureRate: `${(100 * failures / calls).toFixed(1)}%`, ...totals,
      p50Ms: percentile(0.50), p95Ms: percentile(0.95) };
  });
}

if (import.meta.main) {
  loadRepoEnv();
  const rows = await usageSummary(dataDirectory());
  if (rows.length) console.table(rows);
  else console.log("暂无模型调用记录。");
}
