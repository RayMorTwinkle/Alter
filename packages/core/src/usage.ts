import { appendFile, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { raceWithAbortSignal } from "@earendil-works/pi-ai/utils/abort";
import type { Usage } from "@earendil-works/pi-ai";
import type { calendarTime } from "./calendar-time.ts";
import { dataDirectory, loadRepoEnv } from "./config.ts";

export type UsageLine = {
  at: string;
  conversation?: "main" | "task" | "triage" | "judge";
  role?: string;
  thinking?: string;
  taskId?: string;
  wakeId?: string;
  wakeSource?: string;
  wakeAt?: number;
  fallback?: boolean;
  retry?: number;
  costUsd?: number | null;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tools?: string[];
  statsOnly?: true; // Regular non-gateway providers were outside the legacy usage report.
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

export function splitUsage({ input, output, cacheRead, cacheWrite }: Usage) {
  return { input, cacheRead, cacheWrite, inputTokens: input + cacheRead + cacheWrite, outputTokens: output };
}

export const usageRole = (line: UsageLine) => line.role ?? (line.proactive && line.conversation === "task" ? "goal" : line.conversation) ?? "unknown";
export const totalInput = (line: Pick<UsageLine, "input" | "cacheRead" | "cacheWrite" | "inputTokens">) => line.input === undefined ? line.inputTokens ?? 0
  : line.input + (line.cacheRead ?? 0) + (line.cacheWrite ?? 0);

async function estimateCost(dir: string, line: UsageLine) {
  if (line.input === undefined || line.outputTokens === undefined) return null;
  try {
    const prices = JSON.parse(await readFile(join(dir, "prices.json"), "utf8"))?.[line.model];
    const counts = { input: line.input, cacheRead: line.cacheRead, cacheWrite: line.cacheWrite, output: line.outputTokens };
    let cost = 0;
    for (const [key, count] of Object.entries(counts)) {
      const price = prices?.[key];
      if (count === undefined || typeof price !== "number" || !Number.isFinite(price) || price < 0) return null;
      cost += count * price;
    }
    return cost / 1_000_000;
  } catch { return null; }
}

function normalize(line: UsageLine) {
  return { ...line, role: usageRole(line), fallback: line.fallback ?? line.fallbackFrom !== undefined,
    retry: line.retry ?? 0, costUsd: line.costUsd ?? null };
}

export async function appendUsage(dir: string, line: UsageLine) {
  const row = normalize(line);
  if (line.costUsd === undefined) row.costUsd = await estimateCost(dir, line);
  await appendFile(join(dir, "usage.jsonl"), JSON.stringify(row) + "\n", { mode: 0o600 });
}

export async function* usageLines(dir: string): AsyncGenerator<UsageLine> {
  let file;
  try { file = await open(join(dir, "usage.jsonl")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const { size } = await file.stat();
    if (!size) return;
    let tail = "";
    for await (const chunk of file.createReadStream({ end: size - 1, encoding: "utf8", autoClose: false })) {
      const rows = (tail + chunk).split("\n");
      tail = rows.pop()!;
      for (const row of rows) if (row.trim()) yield normalize(JSON.parse(row));
    }
    if (tail.trim()) {
      // A concurrent append can straddle the size snapshot. Its complete row appears on the next read.
      let row: UsageLine;
      try { row = JSON.parse(tail); } catch { return; }
      yield normalize(row);
    }
  } finally { await file.close(); }
}

export async function readUsage(dir: string) {
  const rows: UsageLine[] = [];
  for await (const line of usageLines(dir)) rows.push(line);
  return rows;
}

export const budgetExhausted = "今日主动预算已用完";
export type ProactiveBudget = ReturnType<typeof createProactiveBudget>;
const tokens = (line: UsageLine) => totalInput(line) + (line.outputTokens ?? 0);

export function createProactiveBudget(time: ReturnType<typeof calendarTime>, limit: number, now: () => number, dir?: string) {
  let cached: { day: number; balance: Promise<{ used: number }> } | undefined;
  let pending = Promise.resolve();

  async function restore(day: number, end: number) {
    let used = 0;
    for await (const line of dir ? usageLines(dir) : []) {
      if (!line.proactive && !["triage", "goal", "heartbeat", "schedule"].includes(usageRole(line))) continue;
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
  const totals = { main: empty(), task: empty(), triage: empty(), heartbeat: empty(), judge: empty(), total: empty() };
  for (const line of lines) {
    if (line.statsOnly) continue;
    const role = line.conversation ?? usageRole(line);
    const groups = [totals.total];
    if (role === "task" || role === "main" || role === "triage" || role === "judge") groups.push(totals[role]);
    else if (role === "goal") groups.push(totals.task);
    if (usageRole(line) === "heartbeat") groups.push(totals.heartbeat);
    for (const group of groups) {
      group.input += totalInput(line);
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
  for await (const line of usageLines(dir)) {
    if (line.statsOnly) continue;
    if (conversation && (line.conversation ?? usageRole(line)) !== conversation) continue;
    const group = models.get(line.model) ?? { latencies: [], failures: 0, aborted: 0, fallbacks: 0, inputTokens: 0, outputTokens: 0 };
    group.latencies.push(line.latencyMs);
    // A user-initiated abort is not a provider failure.
    if (line.errorKind === "aborted") group.aborted++;
    else if (line.outcome === "error") group.failures++;
    if (line.fallbackFrom !== undefined || line.fallback) group.fallbacks++;
    group.inputTokens += totalInput(line);
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
