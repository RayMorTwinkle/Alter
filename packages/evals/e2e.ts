import { loadRepoEnv } from "@alter/core";
import { runTask, type Result } from "./runner.ts";
import { cell, runDetails, runSuite } from "./suite.ts";
import { tasks } from "./tasks.ts";

function median(values: number[]) {
  if (!values.length) return "—";
  values.sort((a, b) => a - b);
  return String((values[Math.floor((values.length - 1) / 2)]! + values[Math.floor(values.length / 2)]!) / 2);
}

export function summary(rows: Result[]) {
  const failures = rows.filter(r => r.status === "fail" || r.status === "error");
  const lines = ["# Alter 端到端任务完成率", "", "## 失败样本", "",
    ...failures.map(r => `- ${r.id}（第 ${r.repeat} 次）${r.status === "error" ? "【执行器错误】" : ""} ${cell(r.reason ?? "")}`)];
  if (!failures.length) lines.push("无。");
  lines.push("", "## 完成率与成本", "", "完成率为成功数除以实际运行数。跳过项与执行器错误（准备阶段失败，智能体未收到任务）单列，不计入分母。成本中位数只统计成功运行；调用含回退和中止，延迟为各轮到最后一次活动的耗时之和。", "",
    "| 类别 | 成功 / 实跑 | 完成率 | 跳过 | 执行器错误 | token 中位数（主 / 任务） | 调用中位数 | 延迟中位数（ms） |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const category of ["总计", ...new Set(rows.map(r => r.category))]) {
    const group = rows.filter(r => category === "总计" || r.category === category);
    const pass = group.filter(r => r.status === "pass");
    const skip = group.filter(r => r.status === "skip").length;
    const errors = group.filter(r => r.status === "error").length;
    const ran = group.length - skip - errors;
    const cost = (get: (r: Result) => number) => median(pass.map(get));
    lines.push(`| ${category} | ${pass.length} / ${ran} | ${ran ? (100 * pass.length / ran).toFixed(1) + "%" : "—"} | ${skip} | ${errors} | ${cost(r => r.usage.main.tokens)} / ${cost(r => r.usage.task.tokens)} | ${cost(r => r.usage.total.calls)} | ${cost(r => r.latencyMs)} |`);
  }
  return lines.join("\n") + "\n" + runDetails(rows);
}

export function evaluate(env: NodeJS.ProcessEnv = process.env) {
  return runSuite({ tasks, directory: "evals/e2e", run: runTask, report: summary }, env);
}

if (import.meta.main) {
  loadRepoEnv();
  await evaluate();
}
