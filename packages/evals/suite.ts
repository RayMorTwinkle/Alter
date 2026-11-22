import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createGatewayModels, dataDirectory, gatewayConfig } from "@alter/core";
import { mailConfigFromEnv } from "@alter/plugin-mail";
import { skipReason, type Options, type Result } from "./runner.ts";
import type { Task } from "./tasks.ts";

export const cell = (value: string) => value.replaceAll("|", "\\|").replace(/\s*\n\s*/g, " ");
export function runDetails(rows: Result[]) {
  const lines: string[] = [];
  lines.push("", "## 每次运行", "", "| 任务 | 轮次 | 结果 / 原因 | token（主 / 任务） | 模型调用 | 延迟（ms） | 租用 / 派单 | 审批（工具 / audience / 决定 / 污点） |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |");
  for (const r of rows) {
    const approvals = r.approvals.map(a => `${a.tool} / ${a.audience} / ${a.decision} / ${a.tainted ? "有" : "无"}`).join("，");
    lines.push(`| ${r.id} | ${r.repeat} | ${r.status} ${cell(r.reason ?? "")} | ${r.usage.main.tokens} / ${r.usage.task.tokens} | ${r.usage.total.calls} | ${r.latencyMs} | ${r.tools.enable_tool} / ${r.tools.dispatch_task} | ${approvals || "—"} |`);
  }
  const warnings = rows.flatMap(r => r.cleanup.map(note => `- ${r.id}（第 ${r.repeat} 次） ${cell(note)}`));
  if (warnings.length) lines.push("", "## 种子邮件清理", "", ...warnings);
  return lines.join("\n") + "\n";
}

export function suiteCases<T extends { id: string }>(tasks: T[], env: NodeJS.ProcessEnv) {
  const repeats = Number(env.ALTER_EVAL_REPEATS ?? 1);
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("ALTER_EVAL_REPEATS 必须为正整数");
  const selected = env.ALTER_EVAL_ONLY === undefined ? tasks : [...new Set(env.ALTER_EVAL_ONLY.split(",").map(s => s.trim()))].map(id => {
    const task = tasks.find(t => t.id === id);
    if (!task) throw new Error(`未知任务：${id}`);
    return task;
  });
  return { tasks: selected, repeats };
}

export async function runCases<T extends { id: string }, R extends { id: string; status: string; reason?: string }>(
  { tasks, repeats }: { tasks: T[]; repeats: number }, directory: string, env: NodeJS.ProcessEnv,
  run: (task: T, repeat: number) => Promise<R>, report: (rows: R[]) => string,
) {
  const out = resolve(env.ALTER_EVAL_OUT ?? join(dataDirectory({}), directory, new Date().toISOString()));
  await mkdir(out, { recursive: true });
  const log = join(out, "results.jsonl");
  await writeFile(log, "", { flag: "wx", mode: 0o600 });
  const rows: R[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const task of tasks) {
      const row = await run(task, repeat);
      await appendFile(log, JSON.stringify(row) + "\n");
      rows.push(row);
      console.log(`${row.id} ${repeat}/${repeats} ${row.status}${row.reason ? " · " + row.reason : ""}`);
    }
  }
  await writeFile(join(out, "summary.md"), report(rows), { mode: 0o600 });
  console.log(`报告已写入 ${out}`);
  return rows;
}

export async function runSuite<T extends Pick<Task, "id" | "category">, R extends Result>(suite: {
  tasks: T[]; directory: string;
  run(task: T, options: Options, repeat: number): Promise<R>;
  report(rows: R[]): string;
}, env: NodeJS.ProcessEnv) {
  const cases = suiteCases(suite.tasks, env);
  const mail = env.ALTER_MAIL_ADDRESS?.trim() && env.ALTER_MAIL_AUTH_CODE?.trim() ? mailConfigFromEnv(env) : undefined;
  const plugins = { browser: env.ALTER_BROWSER !== "off", mail };
  const config = cases.tasks.some(task => !skipReason(task, plugins)) ? gatewayConfig(env) : undefined;
  return runCases(cases, suite.directory, env, (task, repeat) => suite.run(task, {
    ...plugins, timeZone: config?.timeZone ?? "UTC", approvalTimeoutMs: config?.approvalTimeoutMs,
    models: dataDir => createGatewayModels({ ...config!, dataDir }),
  }, repeat), suite.report);
}
