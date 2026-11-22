import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { dataDirectory, gatewayConfig, loadRepoEnv } from "../src/config.ts";
import { openAlter } from "../src/main.ts";
import { createGatewayModels } from "../src/models.ts";
import { observeSurface, type AlterApp } from "../src/observe.ts";
import { context, openNodeSqliteStorage } from "../src/runtime.ts";
import { submitMessage } from "../src/timeline.ts";
import { readUsage, usageTotals, type UsageLine } from "../src/usage.ts";

const messages = {
  // The demo calendar only stores titles. Saying so removes clarifying questions, which are not what this eval compares.
  "rename-twice": ["帮我在日历上建一个叫「站会」的日程，只要标题，不用时间。", "把刚才那个改名叫「晨会」。", "再改成「晨会（10:00）」。"],
  "batch-create": ["在日历上建三个日程：「周报」、「一对一」、「复盘」，只要标题，不用时间。"],
  list: ["我日历上现在有哪些日程？"],
};
type Scenario = keyof typeof messages;
const modes = ["lease", "dispatch"] as const;
type Mode = typeof modes[number];
const seed = new Map([["event-weekly", "周报"], ["event-review", "复盘"]]);
const quietMs = 1000;
const turnTimeoutMs = 180_000;

function judge(scenario: Scenario, calendar: Map<string, string>, reply: string) {
  if (scenario === "list") {
    if (calendar.size !== seed.size || [...seed].some(([id, title]) => calendar.get(id) !== title)) {
      return "判定不符：预置日历发生变化";
    }
    if ([...seed.values()].some(title => !reply.includes(title))) return "判定不符：最后一条主会话回复未列出两个日程";
  } else {
    const expected = scenario === "rename-twice" ? ["晨会（10:00）"] : ["周报", "一对一", "复盘"];
    const titles = [...calendar.values()];
    if (titles.length !== expected.length || expected.some(title => !titles.includes(title))) {
      return `判定不符：实际日程为 ${JSON.stringify(titles)}`;
    }
  }
  return null;
}

type ModelSetup = {
  models: Parameters<typeof openAlter>[1];
  mainModel: Parameters<typeof openAlter>[2];
  taskModel?: Parameters<typeof openAlter>[3];
  thinking?: Parameters<typeof openAlter>[4];
};
type Options = ModelSetup & { scenario: Scenario; mode: Mode; dataDir: string; approvalTimeoutMs?: number; timeZone?: string };

type ToolCounts = { enable_tool: number; dispatch_task: number };

async function playTurns(app: AlterApp, scenario: Scenario, tools: ToolCounts, turnLatencyMs: number[]) {
  const { main, harness, demo } = app;
  let lastActivity = 0;
  let lastReply = "";
  let modelError: string | undefined;
  if (scenario === "list") for (const [id, title] of seed) demo.calendar.set(id, title);
  const surface = await observeSurface(app, event => {
    lastActivity = performance.now();
    if (event.event === "timeline" && event.data.kind === "assistant") lastReply = event.data.text;
  });
  const commits = harness.observeCommits({
    advance({ changes }) {
      if (changes.length) lastActivity = performance.now();
      for (const change of changes) {
        if (change.type !== "entry") continue;
        for (const msg of change.value.model ?? []) {
          if (msg.role !== "assistant") continue;
          if (msg.stopReason === "error" || msg.stopReason === "aborted") {
            modelError = `${msg.model} · ${msg.errorMessage ?? msg.stopReason}`;
          }
          if (change.value.conversationId !== main.id) continue;
          for (const part of msg.content) {
            if (part.type === "toolCall" && (part.name === "enable_tool" || part.name === "dispatch_task")) tools[part.name]++;
          }
        }
      }
    }, end() {},
  });
  try {
    harness.resume();
    for (const [i, message] of messages[scenario].entries()) {
      const start = performance.now();
      lastActivity = start;
      const deadline = AbortSignal.timeout(turnTimeoutMs);
      try {
        await awaitWithContext(submitMessage(main, message), withAbortSignal(deadline, context));
        while (true) {
          deadline.throwIfAborted();
          const { busy, tasks } = surface.snapshot();
          const remaining = quietMs - (performance.now() - lastActivity);
          if (!busy && tasks.every(task => task.status !== "running") && remaining <= 0) break;
          await sleep(remaining > 0 ? Math.ceil(remaining) : 100, undefined, { signal: deadline });
        }
      } catch (error) {
        if (!deadline.aborted) throw error;
        return `超时：第 ${i + 1} 轮未在 ${turnTimeoutMs / 1000} 秒内结束`;
      } finally {
        turnLatencyMs.push(Math.round(lastActivity - start));
      }
    }
    const judged = judge(scenario, demo.calendar, lastReply);
    const idle = scenario !== "list" && tools.enable_tool + tools.dispatch_task === 0;
    const mismatch = judged && idle ? `未执行：主会话没有租用也没有派单（${judged}）` : judged;
    return mismatch && modelError ? `异常：${modelError}（${mismatch}）` : mismatch;
  } finally {
    commits.detach();
    surface.detach();
  }
}

export async function runScenario({ scenario, mode, dataDir, models, mainModel, taskModel, thinking, approvalTimeoutMs, timeZone }: Options) {
  const tools = { enable_tool: 0, dispatch_task: 0 };
  const turnLatencyMs: number[] = [];
  let failure: string | null = null;
  function recordError(error: unknown) {
    const reason = `异常：${error instanceof Error ? error.message : String(error)}`;
    failure = failure ? `${failure}；${reason}` : reason;
  }
  try {
    const storage = await openNodeSqliteStorage(join(dataDir, "main.sqlite"));
    let app: AlterApp | undefined;
    try {
      app = await openAlter(storage, models, mainModel, taskModel, thinking, { leasing: mode === "lease", approvalTimeoutMs, timeZone });
      failure = await playTurns(app, scenario, tools, turnLatencyMs);
    } finally {
      if (app) await app.close();
      else await storage.close(context);
    }
  } catch (error) { recordError(error); }
  // Closing aborts in-flight requests on timeout. Include their final usage rows.
  let lines: UsageLine[] = [];
  try { lines = await readUsage(dataDir); }
  catch (error) { recordError(error); }
  const modelsUsed = (role: UsageLine["conversation"]) => [...new Set(lines.filter(line => line.conversation === role).map(line => line.model))];
  return { scenario, mode, correct: failure === null, failure, turnLatencyMs, latencyMs: turnLatencyMs.reduce((a, b) => a + b, 0),
    tools, usage: usageTotals(lines), modelsUsed: { main: modelsUsed("main"), task: modelsUsed("task") } };
}

type Result = Awaited<ReturnType<typeof runScenario>> & { repeat: number };

function summary(results: Result[], scenarios: Scenario[]) {
  const rows = ["# 工具租约与全派任务评测", "",
    "正确率按全部运行计算；token、调用次数、延迟只统计正确运行（失败运行常常什么都没做，会把成本拉低）。" +
    "每轮延迟计至最后一次活动，P90 取最近秩。调用次数包含中止与回退尝试。", "",
    "| 场景 | 模式 | 运行数 | 正确率 | token 中位数（main / task / 总） | 调用次数中位数 | 延迟中位数（秒） | P90（秒） | enable_tool 平均次数 | dispatch_task 平均次数 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"];
  for (const scenario of [...scenarios, "全部场景"]) {
    for (const mode of modes) {
      const all = results.filter(r => r.mode === mode && (scenario === "全部场景" || r.scenario === scenario));
      const group = all.filter(r => r.correct);
      const sorted = (get: (r: Result) => number) => group.map(get).sort((a, b) => a - b);
      const n = group.length;
      const median = (values: number[]) => (values[Math.floor((n - 1) / 2)]! + values[Math.floor(n / 2)]!) / 2;
      const meanCalls = (tool: keyof Result["tools"]) => +(all.reduce((a, r) => a + r.tools[tool], 0) / all.length).toFixed(2);
      const tokens = (["main", "task", "total"] as const).map(role => Math.round(median(sorted(r => r.usage[role].tokens))));
      const seconds = sorted(r => r.latencyMs / 1000);
      const accuracy = Number((100 * n / all.length).toFixed(1));
      const cost = n ? [tokens.join(" / "), median(sorted(r => r.usage.total.calls)), median(seconds).toFixed(1),
        seconds[Math.ceil(n * 0.9) - 1]!.toFixed(1)] : ["—", "—", "—", "—"];
      rows.push(`| ${[scenario, mode, all.length, `${accuracy}%`, ...cost,
        meanCalls("enable_tool"), meanCalls("dispatch_task")].join(" | ")} |`);
    }
  }
  const failures = results.filter(r => !r.correct);
  rows.push("", "## 失败记录", "", ...failures.map(r => `- 第 ${r.repeat} 次 · ${r.scenario} · ${r.mode} · ${r.failure}`));
  if (!failures.length) rows.push("无。");
  return rows.join("\n") + "\n";
}

async function evaluate() {
  loadRepoEnv();
  const config = gatewayConfig();
  const repeats = Number(process.env.ALTER_EVAL_REPEATS ?? 5);
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("ALTER_EVAL_REPEATS 必须为正整数");
  const selected = process.env.ALTER_EVAL_SCENARIOS?.split(",").map(id => id.trim()) ?? Object.keys(messages);
  const scenarios = [...new Set(selected.map(id => {
    if (!Object.hasOwn(messages, id)) throw new Error(`未知场景：${id}`);
    return id as Scenario;
  }))];
  const out = resolve(process.env.ALTER_EVAL_OUT ?? join(dataDirectory({}), "evals/lease-vs-dispatch", new Date().toISOString()));
  await mkdir(out, { recursive: true });
  const log = join(out, "results.jsonl");
  await writeFile(log, "", { flag: "wx" });
  const results: Result[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const scenario of scenarios) {
      for (const mode of modes) {
        const dataDir = await mkdtemp(join(out, `${repeat}-${scenario}-${mode}-`));
        const setup = await createGatewayModels({ ...config, dataDir });
        const result = await runScenario({ scenario, mode, dataDir, ...setup, timeZone: config.timeZone, approvalTimeoutMs: config.approvalTimeoutMs });
        const row = { ...result, repeat, dataDir: basename(dataDir), model: { main: config.main, task: config.task }, thinking: setup.thinking };
        await appendFile(log, JSON.stringify(row) + "\n");
        results.push(row);
        console.log(`${scenario} ${mode} ${repeat}/${repeats} ${row.correct ? "正确" : "失败"} ${(row.latencyMs / 1000).toFixed(1)}s ${row.usage.total.tokens} token`);
      }
    }
  }
  const report = join(out, "summary.md");
  await writeFile(report, summary(results, scenarios));
  console.log(`汇总已写入 ${report}`);
}

if (import.meta.main) await evaluate();
