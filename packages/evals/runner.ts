import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import {
  answerUserPermission, context, observeSurface, openAlter, openNodeSqliteStorage, readUsage, submitMessage, usageTotals,
  type AlterApp, type AlterPlugin,
} from "@alter/core";
import { createBrowserPlugin } from "@alter/plugin-browser";
import { createCalendarPlugin } from "@alter/plugin-calendar";
import { createMailPlugin, type MailConfig } from "@alter/plugin-mail";
import { mailSeed } from "../plugin-mail/scripts/eval-seed.ts";
import { events, fixtures, startPages } from "./fixtures.ts";
import type { Approval, Task, TaskContext } from "./tasks.ts";

type ModelSetup = {
  models: Parameters<typeof openAlter>[1]; mainModel: Parameters<typeof openAlter>[2];
  taskModel?: Parameters<typeof openAlter>[3]; thinking?: Parameters<typeof openAlter>[4];
};
export type Options = {
  models(dataDir: string): Promise<ModelSetup>;
  timeZone: string; browser: boolean; mail?: MailConfig; approvalTimeoutMs?: number;
  plugins?: AlterPlugin[];
  mailPlugin?(config: MailConfig): AlterPlugin;
  browserPlugin?(): AlterPlugin;
  demos?: boolean; // Off like the web server; offline tests opt in to drive the simulated outbox.
};
export type Result = {
  id: string; category: Task["category"]; repeat: number; status: "pass" | "fail" | "skip" | "error"; reason?: string;
  turns: string[]; reply: string; tools: { enable_tool: number; dispatch_task: number }; approvals: Approval[];
  turnLatencyMs: number[]; latencyMs: number; usage: ReturnType<typeof usageTotals>; cleanup: string[];
};

export function skipReason(task: Pick<Task, "category">, options: Pick<Options, "mail" | "browser">) {
  if (task.category === "邮箱" && !options.mail) return "缺少 ALTER_MAIL_ADDRESS 或 ALTER_MAIL_AUTH_CODE";
  if ((task.category === "浏览器" || task.category === "组合") && !options.browser) return "ALTER_BROWSER=off";
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function play(task: Task, c: TaskContext, result: Result) {
  const { main, harness } = c.app;
  const seen = new Map<string, Approval>();
  let activity = performance.now();
  let modelError: string | undefined;
  const surface = await observeSurface(c.app, event => {
    activity = performance.now();
    if (event.event === "timeline" && event.data.kind === "message") c.reply = [c.reply, event.data.text].filter(Boolean).join("\n");
    if (event.event === "pending") {
      for (const { id, taskId, tool, audience, capability, arguments: args } of event.data) {
        if (seen.has(id)) continue;
        const row: Approval = { id, taskId, tool, audience, capability, arguments: args, decision: "pending" };
        seen.set(id, row);
        result.approvals.push(row);
      }
    }
  });
  const commits = harness.observeCommits({
    advance({ changes }) {
      if (changes.length) activity = performance.now();
      for (const change of changes) {
        if (change.type !== "entry") continue;
        for (const msg of change.value.model ?? []) {
          if (msg.role !== "assistant") continue;
          if (msg.stopReason === "error" || msg.stopReason === "aborted") modelError = msg.errorMessage ?? msg.stopReason;
          if (change.value.conversationId !== main.id) continue;
          for (const part of msg.content) {
            if (part.type === "toolCall" && (part.name === "enable_tool" || part.name === "dispatch_task")) result.tools[part.name]++;
          }
        }
      }
    }, end() {},
  });
  try {
    harness.resume();
    for (const [index, turn] of task.turns.entries()) {
      if (index > 0 && task.category === "日历") c.beforeFollowup = events(c);
      const text = typeof turn === "string" ? turn : turn(c);
      c.reply = "";
      const start = activity = performance.now();
      const deadline = AbortSignal.timeout(240_000);
      const ctx = withAbortSignal(deadline, context);
      try {
        await awaitWithContext(submitMessage(main, text), ctx);
        result.turns.push(text);
        while (true) {
          deadline.throwIfAborted();
          const { busy, tasks, pending } = surface.snapshot();
          for (const req of pending) {
            const row = seen.get(req.id)!;
            if (req.audience !== "user" || row.decision !== "pending") continue;
            const allow = task.approvals?.(req) ?? false;
            const answer = await awaitWithContext(answerUserPermission(main, { requestId: req.id, decision: allow ? "once" : "deny" }), ctx);
            if (answer.isError) throw new Error(`审批 ${req.id} 未送达：${answer.output[0]?.text}`);
            row.decision = allow ? "allow" : "deny";
          }
          if (!busy && !pending.length && tasks.every(t => t.status !== "running") && performance.now() - activity >= 1000) break;
          await sleep(100, undefined, { signal: deadline });
        }
      } catch (error) {
        if (deadline.aborted) throw new Error(`第 ${index + 1} 轮超过 4 分钟`);
        throw error;
      } finally {
        result.turnLatencyMs.push(Math.round((deadline.aborted ? performance.now() : activity) - start));
      }
    }
    const mismatch = await task.check(c);
    return mismatch && modelError ? `${mismatch}；模型错误：${modelError}` : mismatch;
  } finally {
    commits.detach();
    surface.detach();
    result.reply = c.reply;
  }
}

export async function runTask(task: Task, options: Options, repeat = 1): Promise<Result> {
  const result: Result = { id: task.id, category: task.category, repeat, status: "pass", turns: [], reply: "",
    tools: { enable_tool: 0, dispatch_task: 0 }, approvals: [], latencyMs: 0, turnLatencyMs: [], usage: usageTotals([]), cleanup: [] };
  const skipped = skipReason(task, options);
  if (skipped) return { ...result, status: "skip", reason: skipped };

  function fail(reason: string) {
    if (result.status !== "error") result.status = "fail";
    result.reason = result.reason ? result.reason + "；" + reason : reason;
  }
  let dataDir: string | undefined;
  const stops: (() => Promise<void>)[] = [];
  try {
    dataDir = await mkdtemp(join(tmpdir(), "alter-e2e-"));
    const f = fixtures(dataDir, options.timeZone, Date.now());
    const now = () => f.now; // All turns and the oracle share the local date even across midnight.
    const plugins: AlterPlugin[] = [createCalendarPlugin({ dataDir, timeZone: f.timeZone, now })];
    plugins.push(...(options.plugins ?? []));
    if (options.mail) plugins.push((options.mailPlugin ?? createMailPlugin)(options.mail));
    if (options.browser) plugins.push((options.browserPlugin ?? createBrowserPlugin)());
    const { models, mainModel, taskModel, thinking } = await options.models(dataDir);
    const storage = await openNodeSqliteStorage(join(dataDir, "main.sqlite"));
    let app: AlterApp | undefined;
    // Close the app first so timed-out model calls are recorded before we read usage.
    const closeApp = () => app ? app.close() : storage.close(context);
    stops.push(closeApp);
    app = await openAlter(storage, models, mainModel, taskModel, thinking,
      { plugins, demos: options.demos ?? false, timeZone: f.timeZone, now, approvalTimeoutMs: options.approvalTimeoutMs });
    const c: TaskContext = { ...f, app, reply: "", approvals: result.approvals };
    if (task.category === "浏览器" || task.category === "组合") {
      c.web = await startPages(f, task.page?.(f));
      stops.push(c.web.close);
    }
    if (task.category === "邮箱" && options.mail) {
      const seed = mailSeed(options.mail, f.id, task.mailBody?.(f) ?? `${f.eventText}\n确认码：${f.token}`);
      c.mail = seed;
      // Register before SMTP. Even a setup error can leave a delivered seed or a Sent copy.
      stops.push(async () => {
        try { await seed.clean(); }
        catch (error) { result.cleanup.push(`可能残留种子「${seed.subject}」${seed.messageId}：${message(error)}`); }
      });
    }
    await task.setup?.(c);
    const mismatch = await play(task, c, result);
    if (mismatch) fail(mismatch);
  } catch (error) {
    if (result.turns.length) fail(message(error));
    else {
      result.status = "error";
      result.reason = "准备失败：" + message(error);
    }
  } finally {
    for (const stop of stops) {
      try { await stop(); } catch (error) { fail(`关闭失败：${message(error)}`); }
    }
    if (dataDir) {
      try { result.usage = usageTotals(await readUsage(dataDir)); } catch (error) { fail(message(error)); }
      try { await rm(dataDir, { recursive: true, force: true }); } catch (error) { fail(`删除临时目录失败：${message(error)}`); }
    }
  }
  result.latencyMs = result.turnLatencyMs.reduce((sum, ms) => sum + ms, 0);
  return result;
}
