import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createGatewayModels, dataDirectory, gatewayConfig } from "@alter/core";
import { mailConfigFromEnv } from "@alter/plugin-mail";
import { runTask, skipReason, type Result } from "./runner.ts";
import { tasks } from "./tasks.ts";

const cell = (value: string) => value.replaceAll("|", "\\|").replace(/\s*\n\s*/g, " ");
function median(values: number[]) {
  if (!values.length) return "—";
  values.sort((a, b) => a - b);
  return String((values[Math.floor((values.length - 1) / 2)]! + values[Math.floor(values.length / 2)]!) / 2);
}

export function summary(rows: Result[]) {
  const failures = rows.filter(r => r.status === "fail");
  const lines = ["# Alter 端到端任务完成率", "", "## 失败样本", "",
    ...failures.map(r => `- ${r.id}（第 ${r.repeat} 次） ${cell(r.reason ?? "")}`)];
  if (!failures.length) lines.push("无。");
  lines.push("", "## 完成率与成本", "", "完成率为成功数除以实际运行数。跳过项单列。成本中位数只统计成功运行；调用含回退和中止，延迟为各轮到最后一次活动的耗时之和。", "",
    "| 类别 | 成功 / 实跑 | 完成率 | 跳过 | token 中位数（主 / 任务） | 调用中位数 | 延迟中位数（ms） |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const category of ["总计", ...new Set(rows.map(r => r.category))]) {
    const group = rows.filter(r => category === "总计" || r.category === category);
    const pass = group.filter(r => r.status === "pass");
    const skip = group.filter(r => r.status === "skip").length;
    const ran = group.length - skip;
    const cost = (get: (r: Result) => number) => median(pass.map(get));
    lines.push(`| ${category} | ${pass.length} / ${ran} | ${ran ? (100 * pass.length / ran).toFixed(1) + "%" : "—"} | ${skip} | ${cost(r => r.usage.main.tokens)} / ${cost(r => r.usage.task.tokens)} | ${cost(r => r.usage.total.calls)} | ${cost(r => r.latencyMs)} |`);
  }
  lines.push("", "## 每次运行", "", "| 任务 | 轮次 | 结果 / 原因 | token（主 / 任务） | 模型调用 | 延迟（ms） | 租用 / 派单 | 审批（工具 / audience / 决定） |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |");
  for (const r of rows) {
    const approvals = r.approvals.map(a => `${a.tool} / ${a.audience} / ${a.decision}`).join("，");
    lines.push(`| ${r.id} | ${r.repeat} | ${r.status} ${cell(r.reason ?? "")} | ${r.usage.main.tokens} / ${r.usage.task.tokens} | ${r.usage.total.calls} | ${r.latencyMs} | ${r.tools.enable_tool} / ${r.tools.dispatch_task} | ${approvals || "—"} |`);
  }
  const warnings = rows.flatMap(r => r.cleanup.map(note => `- ${r.id}（第 ${r.repeat} 次） ${cell(note)}`));
  if (warnings.length) lines.push("", "## 种子邮件清理", "", ...warnings);
  return lines.join("\n") + "\n";
}

export async function evaluate(env: NodeJS.ProcessEnv = process.env) {
  const repeats = Number(env.ALTER_EVAL_REPEATS ?? 1);
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("ALTER_EVAL_REPEATS 必须为正整数");
  const selected = env.ALTER_EVAL_ONLY === undefined ? tasks : [...new Set(env.ALTER_EVAL_ONLY.split(",").map(s => s.trim()))].map(id => {
    const task = tasks.find(t => t.id === id);
    if (!task) throw new Error(`未知任务：${id}`);
    return task;
  });
  const mail = env.ALTER_MAIL_ADDRESS?.trim() && env.ALTER_MAIL_AUTH_CODE?.trim() ? mailConfigFromEnv(env) : undefined;
  const plugins = { browser: env.ALTER_BROWSER !== "off", mail };
  const config = selected.some(task => !skipReason(task, plugins)) ? gatewayConfig(env) : undefined;
  const out = resolve(env.ALTER_EVAL_OUT ?? join(dataDirectory({}), "evals/e2e", new Date().toISOString()));
  await mkdir(out, { recursive: true });
  const log = join(out, "results.jsonl");
  await writeFile(log, "", { flag: "wx", mode: 0o600 });
  const rows: Result[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const task of selected) {
      const row = await runTask(task, { ...plugins, timeZone: config?.timeZone ?? "UTC",
        approvalTimeoutMs: config?.approvalTimeoutMs, models: dataDir => createGatewayModels({ ...config!, dataDir }) }, repeat);
      await appendFile(log, JSON.stringify(row) + "\n");
      rows.push(row);
      console.log(`${row.id} ${repeat}/${repeats} ${row.status}${row.reason ? " · " + row.reason : ""}`);
    }
  }
  await writeFile(join(out, "summary.md"), summary(rows), { mode: 0o600 });
  console.log(`报告已写入 ${out}`);
  return rows;
}

if (import.meta.main) await evaluate();
