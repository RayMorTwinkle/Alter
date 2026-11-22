import { classify, createGatewayModels, gatewayConfig, prefilter, proactiveConfig, usageTotals, type ExternalEvent, loadRepoEnv } from "@alter/core";
import { cell, runCases, suiteCases } from "./suite.ts";
import { profile, samples, type Level, type Sample } from "./triage-samples.ts";

const levels: Level[] = ["now", "digest", "silent"];
type Row = Sample & {
  repeat: number; predicted: Level; reason: string; status: "pass" | "fail" | "error";
  validOutput: boolean; filtered: string | null; usage: Awaited<ReturnType<typeof classify>>["line"];
};

const ratio = (n: number, d: number) => d ? n / d : null;
const percent = (value: number | null) => value === null ? "—" : (100 * value).toFixed(1) + "%";

export function metrics(rows: Row[]) {
  const counts = () => ({ now: 0, digest: 0, silent: 0 });
  const matrix = { now: counts(), digest: counts(), silent: counts() };
  for (const row of rows) matrix[row.expected][row.predicted]++;
  const injected = rows.filter(row => row.injection);
  return {
    matrix, accuracy: ratio(rows.filter(row => row.status === "pass").length, rows.length),
    finalAccuracy: ratio(levels.reduce((sum, level) => sum + matrix[level][level], 0), rows.length),
    nowPrecision: ratio(matrix.now.now, matrix.now.now + matrix.digest.now + matrix.silent.now),
    nowRecall: ratio(matrix.now.now, matrix.now.now + matrix.now.digest + matrix.now.silent),
    injectionNow: ratio(injected.filter(row => row.predicted === "now").length, injected.length),
    legal: rows.filter(row => levels.includes(row.predicted)).length,
    valid: rows.filter(row => row.validOutput).length,
    filtered: new Set(rows.filter(row => row.filtered).map(row => row.id)).size,
    usage: usageTotals(rows.map(row => row.usage)).triage,
  };
}

export function summary(rows: Row[]) {
  const m = metrics(rows);
  const ids = new Set(rows.map(row => row.id));
  const lines = ["# Alter 主动事件分诊评测", "", "## 失败样本", ""];
  const failures = rows.filter(row => row.status !== "pass");
  for (const r of failures) {
    const fallback = r.status === "error" ? "调用失败" : !r.validOutput ? "输出格式无效" : "";
    lines.push(`- ${r.id}（第 ${r.repeat} 次） ${r.expected} → ${r.predicted} ${fallback}。事件：${cell(r.summary)} 人工依据：${r.rationale} 分诊理由：${cell(r.reason)}`);
  }
  if (!failures.length) lines.push("无。");
  lines.push("", "## 指标", "", `画像：${profile}`, "",
    `- ${ids.size} 条样本，${rows.length} 次分诊。预过滤会拦掉 ${m.filtered} 条样本（按 ID 去重），均已送入模型。`,
    `- 总体准确率 ${percent(m.accuracy)}（格式无效或调用失败计错）。降级后最终标签准确率 ${percent(m.finalAccuracy)}。now 精准率 ${percent(m.nowPrecision)}，now 召回率 ${percent(m.nowRecall)}。`,
    `- 注入样本被判为 now 的比例 ${percent(m.injectionNow)}（越低越好，人工标签以事件本身为准）。`,
    `- 最终合法标签 ${m.legal}/${rows.length}。模型直接返回合规输出 ${m.valid}/${rows.length}。混淆矩阵和 now 指标按最终标签统计。`,
    `- 模型 ${[...new Set(rows.map(r => r.usage.model))].join("、")}。调用 ${m.usage.calls} 次，已报告 token ${m.usage.tokens}（输入 ${m.usage.input}，输出 ${m.usage.output}）。`,
    "", "## 混淆矩阵", "", "| 人工标签 / 最终标签 | now | digest | silent |", "| --- | ---: | ---: | ---: |");
  for (const level of levels) {
    const counts = m.matrix[level];
    lines.push(`| ${level} | ${counts.now} | ${counts.digest} | ${counts.silent} |`);
  }
  return lines.join("\n") + "\n";
}

export async function evaluate(env: NodeJS.ProcessEnv = process.env) {
  const cases = suiteCases(samples, env);
  const { models, taskModel } = await createGatewayModels(gatewayConfig(env));
  const { mute } = proactiveConfig(env);
  const memory = "[记忆摘要]\n画像：" + profile;
  const signal = new AbortController().signal;
  return runCases(cases, "evals/triage", env, async (sample, repeat): Promise<Row> => {
    const at = Date.now();
    const event: ExternalEvent = { at, kind: "received", source: sample.source, summary: sample.summary, ref: sample.id, untrusted: true };
    const filtered = prefilter(event, false, mute)?.filtered ?? null;
    const { decision, line, validOutput } = await classify(models, taskModel, memory, event, at, signal);
    const status = line.outcome === "error" ? "error" : validOutput && decision.level === sample.expected ? "pass" : "fail";
    return { ...sample, repeat, filtered, predicted: decision.level, reason: decision.reason, status, validOutput, usage: line };
  }, summary);
}

if (import.meta.main) {
  loadRepoEnv();
  await evaluate();
}
