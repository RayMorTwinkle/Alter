import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import type { ApprovalAnswer, ApprovalRequest, Effect, Report, TaskEnd, TaskStart } from "@alter/node-protocol";
import { loadConfig, taskDirectory } from "./config.ts";
import { finishScript, reportSchema } from "./finish.ts";
import { Outbox, type Entry } from "./outbox.ts";
import type { Detected } from "./spawn.ts";
import { acp } from "./adapters/acp.ts";
import { claude } from "./adapters/claude.ts";
import { codex } from "./adapters/codex.ts";
import type { Outcome, RunningTask, Sink } from "./adapters/types.ts";

function effect(tool: string): Effect {
  if (/^(read|glob|grep|ls|webfetch|websearch)$/i.test(tool)) return "read";
  if (/^(edit|write|multiedit|notebookedit|apply_patch)$/i.test(tool)) return "write";
  return "irreversible";
}
const occupiedSession = /(?:session|thread)[^\n]*(?:already (?:owned|active|open|in use)|(?:is|currently) (?:in use|locked|busy))|session[._ -](?:busy|lock(?:ed)?)\b|会话.*(?:占用|锁定)/i;
type Settlement = Pick<TaskEnd, "status" | "report" | "reportSource">;

function settle(outcome: Outcome, file: string, last: string, output: string): Settlement {
  if (outcome.status === "completed") {
    if (file && existsSync(file)) {
      const report: Report = reportSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      return { status: "completed", reportSource: "finish", report };
    }
    if (last.trim()) return { status: "completed", reportSource: "last_message", report: { summary: last, refs: [] } };
    outcome = { status: "failed", reason: "代理结束但未提交报告或助手正文" };
  }
  const reason = outcome.reason || (outcome.status === "interrupted" ? "任务已中断" : "代理执行失败");
  return { status: outcome.status, reportSource: "failure", report: { summary: [reason, last || output].filter(Boolean).join("\n"), refs: [] } };
}

type Reply = Pick<ApprovalAnswer, "decision" | "note">;
type Active = { queue: string[]; stop(outcome: Outcome): Promise<void> };

export class Tasks {
  dir: string;
  box: Outbox;
  harnesses: Detected[];
  send: (entry: Entry) => void;
  active = new Map<string, Active>();
  approvals = new Map<string, { request: ApprovalRequest; answer(reply: Reply): void }>();
  timeoutMs: number;

  constructor(dir: string, harnesses: Detected[], send: (entry: Entry) => void, timeoutMs = 4 * 60 * 60 * 1000) {
    this.dir = dir; this.box = new Outbox(dir); this.harnesses = harnesses; this.send = send; this.timeoutMs = timeoutMs;
    for (const { taskId, state } of this.box.tasks()) if (state === "running") {
      const last = this.box.journals.get(taskId)?.findLast(e => e.type === "task.event" && e.kind === "text");
      const suffix = last?.type === "task.event" && last.text ? "\n" + last.text : "";
      this.box.append(taskId, { type: "task.end", status: "failed", reportSource: "failure",
        report: { summary: "节点上次退出时任务尚未结算，执行结果未知。" + suffix, refs: [] } });
    }
  }

  start(task: TaskStart) {
    const id = task.taskId;
    if (typeof id !== "string" || !id || this.box.known(id)) return;
    const publish = (body: Parameters<Outbox["append"]>[1]) => {
      const entry = this.box.append(id, body);
      this.send(entry);
      return entry;
    };
    publish({ type: "task.event", kind: "status", text: "正在启动" });
    let handle: RunningTask | undefined, session: string | undefined, last = "", output = "", folder = "", reportFile = "";
    const queue: string[] = [];
    let closing: Promise<void> | undefined;
    const stop = (outcome: Outcome): Promise<void> => {
      if (closing) return closing;
      // Mark closing before any native interrupt/EOF callbacks can reenter.
      closing = Promise.resolve().then(async () => {
        clearTimeout(timer);
        for (const pending of this.approvals.values()) if (pending.request.taskId === id)
          pending.answer({ decision: "deny", note: "任务已结束" });
        if (task.resume && outcome.status === "failed" && outcome.reason && occupiedSession.test(outcome.reason)) {
          outcome = { ...outcome, reason: "该会话正在原界面打开，关掉后再试\n" + outcome.reason };
        }
        let result: Settlement;
        try {
          await handle?.stop(outcome.status !== "completed");
          result = settle(outcome, reportFile, last, output);
        } catch (err) {
          const status = outcome.status === "interrupted" ? "interrupted" : "failed";
          result = settle({ status, reason: [outcome.reason, String(err)].filter(Boolean).join("\n") }, reportFile, last, output);
        }
        try { publish({ type: "task.end", ...result, nativeSessionId: session, usage: outcome.usage }); }
        finally { this.active.delete(id); if (folder) rmSync(folder, { recursive: true, force: true }); }
      });
      return closing;
    };
    const timer = setTimeout(() => void stop({ status: "failed", reason: "任务执行超时" }), this.timeoutMs);
    this.active.set(id, { queue, stop });
    const sink: Sink = {
      session(value) { if (!closing) session = value; },
      event(e) { if (!closing) { if (e.text?.trim()) output = e.text; publish({ type: "task.event", ...e }); } },
      assistant(text) { if (!closing && text.trim()) last = text; },
      approve: async (tool, args, signal, nativeEffect) => {
        if (closing || signal?.aborted) return { decision: "deny", note: "请求已取消" };
        const requestId = randomUUID();
        return new Promise(resolve => {
          const abort = () => answer({ decision: "deny", note: "请求已取消" });
          const answer = (reply: Reply) => {
            signal?.removeEventListener("abort", abort); this.approvals.delete(requestId); resolve(reply);
          };
          const command = typeof args === "object" && args !== null && "command" in args && typeof args.command === "string" ? args.command : "";
          const request = this.box.append(id, { type: "approval.request", tool, args, requestId, effect: nativeEffect ?? effect(tool),
            summary: command ? "请求执行命令 " + command : "请求使用 " + tool }) as ApprovalRequest;
          this.approvals.set(requestId, { request, answer });
          signal?.addEventListener("abort", abort, { once: true });
          this.send(request);
        });
      },
      turn(outcome) {
        if (closing) return;
        const next = queue.shift();
        if (outcome.status !== "completed" || next === undefined || !handle) { void stop(outcome); return; }
        try {
          rmSync(reportFile, { force: true }); last = ""; output = "";
          void Promise.resolve(handle.message(next)).catch(err => stop({ status: "failed", reason: String(err) }));
        } catch (err) { void stop({ status: "failed", reason: String(err) }); }
      },
    };
    try {
      if (!["restricted", "auto", "full"].includes(task.permission) || typeof task.brief !== "string") throw new Error("任务参数无效");
      const config = loadConfig(this.dir);
      const cwd = taskDirectory(config.roots, task.cwd);
      const executable = this.harnesses.find(h => h.available && h.id === task.harness)?.executable;
      if (!executable) throw new Error("代理不可用");
      folder = mkdtempSync(path.join(tmpdir(), "alter-finish-")); reportFile = path.join(folder, "report.json");
      const adapter = { codex, "claude-code": claude, dsh: acp, opencode: acp }[task.harness];
      const model = task.resume ? undefined : config.models?.[task.harness];
      handle = adapter.start({ ...task, cwd, executable, model, finish: { command: process.execPath, args: [finishScript, reportFile] } }, sink);
    } catch (err) { void stop({ status: "failed", reason: String(err) }); }
  }

  answer(msg: ApprovalAnswer) {
    const pending = this.approvals.get(msg.requestId);
    if (pending && pending.request.taskId === msg.taskId && ["once", "capability", "always", "deny"].includes(msg.decision)) pending.answer(msg);
  }

  replay(acks: Record<string, number>) {
    const waiting = new Set(Array.from(this.approvals.values(), p => p.request));
    for (const [id, entries] of this.box.journals) {
      const seq = Object.hasOwn(acks, id) && Number.isSafeInteger(acks[id]) && acks[id]! <= entries.length ? acks[id]! : 0;
      this.box.ack(id, seq);
      for (const e of entries) if (e.seq > seq || (e.type === "approval.request" && waiting.has(e))) this.send(e);
    }
  }

  async shutdown() {
    await Promise.all(Array.from(this.active.values(), t => t.stop({ status: "interrupted", reason: "节点正在退出" })));
  }
}
