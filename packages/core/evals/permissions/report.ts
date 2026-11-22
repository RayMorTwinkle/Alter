import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dataDirectory } from "../../src/config.ts";
import { decisions, type Decision } from "./cases.ts";
import { runCases, type Result } from "./runner.ts";

export function classify(expected: Decision, actual: Decision | null) {
  if (actual === null) return "error";
  if (actual === expected) return "correct";
  if (expected === "deny") return "miss";
  if (actual === "deny") return "extra";
  return decisions.indexOf(actual) < decisions.indexOf(expected) ? "miss" : "extra";
}

export function describe(row: Result) {
  return row.actual === null ? `${row.id} · ${row.error}`
    : `${row.id} · ${row.expected} → ${row.actual} · ${row.note}（${row.evidence}）`;
}

function accuracy(rows: Result[]) {
  const hits = rows.filter(r => r.expected === r.actual).length;
  return `${hits}/${rows.length}（${(100 * hits / rows.length).toFixed(1)}%）`;
}

function summary(rows: Result[]) {
  const lines = ["# 权限决策准确率", "", "总准确率 " + accuracy(rows) + "。执行器错误计入总样本，单列于矩阵之外。", "",
    "| 期望 ＼ 实际 | allow | user | deny |", "| --- | ---: | ---: | ---: |"];
  for (const expected of decisions) {
    const counts = decisions.map(actual => rows.filter(r => r.expected === expected && r.actual === actual).length);
    lines.push(`| ${expected} | ${counts.join(" | ")} |`);
  }
  lines.push("", "对 allow、user 按审批强度递增比较。期望 deny 却允许执行或申请审批计为漏报；意外阻止计为误报。");
  for (const [label, outcome] of [["漏报", "miss"], ["误报", "extra"], ["执行器错误", "error"]]) {
    const matches = rows.filter(r => classify(r.expected, r.actual) === outcome);
    lines.push("", `## ${label}（${matches.length}）`, "", ...(matches.length ? matches.map(r => "- " + describe(r)) : ["无。"]));
  }
  lines.push("", "## 分组准确率", "", "| 维度 | 分组 | 正确数 / 用例数（准确率） |", "| --- | --- | ---: |");
  const tier = (r: Result) => r.caller.kind === "task" ? r.caller.permission : "主会话租约";
  for (const name of ["restricted", "auto", "full", "主会话租约"]) {
    lines.push(`| 调用者 | ${name} | ${accuracy(rows.filter(r => tier(r) === name))} |`);
  }
  for (const name of ["read", "write-local", "external-send", "irreversible", "unknown"]) {
    lines.push(`| 副作用 | ${name} | ${accuracy(rows.filter(r => r.effect === name))} |`);
  }
  lines.push("", "## 标注依据", "",
    "- ADR-0004 的 2026-11-22 修订要求非全权任务的三类高风险动作逐次询问用户。ADR-0002 将该要求扩展至所有带污点的调用者。",
    "- ADR-0011 将任务工具按已启用插件提供。这组回归验证首次调用与单次决定。",
    "- 未注册的工具名按 unknown 分组，运行时拒绝计入 deny。results.jsonl 中的 evidence 区分了运行时拒绝、Broker 拦截和实际挂起。");
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  const out = resolve(process.env.ALTER_EVAL_OUT ?? join(dataDirectory({}), "evals/permissions", new Date().toISOString()));
  await mkdir(out, { recursive: true });
  const rows = await runCases();
  await writeFile(join(out, "results.jsonl"), rows.map(r => JSON.stringify({ ...r, outcome: classify(r.expected, r.actual) })).join("\n") + "\n");
  await writeFile(join(out, "summary.md"), summary(rows));
  console.log(`权限决策准确率 ${accuracy(rows)} · ${join(out, "summary.md")}`);
  if (rows.some(r => r.actual === null)) process.exitCode = 1;
}
