import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory, loadRepoEnv } from "./config.ts";

export type UsageLine = {
  at: string;
  conversation: "main" | "task";
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

export async function usageSummary(dir: string) {
  let contents: string;
  try {
    contents = await readFile(join(dir, "usage.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const models = new Map<string, { latencies: number[]; failures: number; aborted: number; fallbacks: number; inputTokens: number; outputTokens: number }>();
  for (const row of contents.split("\n").filter(Boolean)) {
    const line: UsageLine = JSON.parse(row);
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
