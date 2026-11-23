import { setTimeout as sleep } from "node:timers/promises";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as say, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj } from "@earendil-works/pi-schema";
import { answerUserPermission, Requests } from "../../src/broker.ts";
import type { AlterPlugin, Capability } from "../../src/capabilities.ts";
import { openAlter } from "../../src/main.ts";
import { context, defineTool, LiveDoc, MemoryStorage, reply, ToolResultEntry, type EntryRecord } from "../../src/runtime.ts";
import { Tasks } from "../../src/state.ts";
import { cases, type Decision, type PermissionCase } from "./cases.ts";

const actions: Capability["actions"] = [
  { name: "read", effect: "read" }, { name: "write", effect: "write-local" },
  { name: "send", effect: "external-send" }, { name: "delete", effect: "irreversible" },
  { name: "run", effect: "unknown" }, { name: "untrusted", effect: "read" },
];
const fixture: AlterPlugin = {
  capability: { id: "fixture", mainLeasable: true, actions },
  tools: actions.map(({ name }) => defineTool({
    name: "fixture_" + name, description: name, parameters: obj({}),
    execute: async () => name === "untrusted" ? { ...reply('<external url="https://example.test/?a=1&amp;b=2">外部内容</external>'),
      details: { untrusted: true } } : reply(name),
  })),
};

type Observation = { actual: Decision; evidence: string };
export type Result = PermissionCase & (Observation | { actual: null; error: string });
type Call = ReturnType<typeof fauxToolCall>;
function call(id: string, tool: string, args: Call["arguments"] = {}) {
  return fauxToolCall(tool, args, { id });
}

function script(c: PermissionCase) {
  const main: Call[] = [];
  const child: Call[] = [];
  const lease = (capability: string) => call("lease-" + capability, "enable_tool", { capability, reason: "评测" });
  if (c.taint === "main-read") main.push(lease("fixture"));
  if (c.caller.kind === "lease") {
    if (c.caller.capability !== "fixture" || c.taint !== "main-read") main.push(lease(c.caller.capability));
  }
  if (c.taint === "main-read") main.push(call("seed-main", "fixture_untrusted"));
  if (c.caller.kind === "task") {
    const { permission, context } = c.caller;
    main.push(call("dispatch", "dispatch_task", { brief: "eval-child", permission, context }));
    if (c.taint === "task-read") child.push(call("seed-task", "fixture_untrusted"));
    if (c.priorApproval === "send" || c.priorApproval === "send-denied") child.push(call("prior", "outbox_send", { message: "第一条" }));
  }
  const callerSteps = c.caller.kind === "lease" ? main : child;
  callerSteps.push(call("target", c.tool, c.args));
  if (c.caller.kind === "task" && c.tool !== "finish") child.push(call("report", "finish", { summary: "完成", refs: [] }));
  return (last: Message) => {
    let next: Call | undefined;
    if (last.role === "user") {
      const text = contentText(last.content).replace(/^\[当前时间 [^\n]*\]\n/, "");
      if (text === "eval-main") next = main[0];
      if (text === "eval-child") next = child[0];
    }
    if (last.role === "toolResult" && (!last.isError || last.toolCallId === "target" || last.toolCallId === "prior")) {
      for (const steps of [main, child]) {
        const index = steps.findIndex(step => step.id === last.toolCallId);
        if (index !== -1) next = steps[index + 1];
      }
    }
    return next ? say(next, { stopReason: "toolUse" }) : say("OK");
  };
}

function completed(entry: EntryRecord, expectedErrors: string[]): Observation | undefined {
  if (!ToolResultEntry.is(entry)) return;
  const message = entry.model?.[0];
  if (message?.role !== "toolResult") return;
  const text = contentText(message.content);
  if (message.toolCallId === "target") {
    if (!message.isError) return { actual: "allow", evidence: text };
    const diagnostic = entry.data.diagnostics.find(d => d.code === "tool_unavailable" || d.code === "blocked");
    if (diagnostic) return { actual: "deny", evidence: diagnostic.code + " · " + diagnostic.message };
  }
  if (message.isError && message.toolCallId !== "report" && !expectedErrors.includes(message.toolCallId)) throw new Error(message.toolName + " · " + text);
}

async function play(c: PermissionCase, signal: AbortSignal, plugins: AlterPlugin[]): Promise<Observation> {
  const ctx = withAbortSignal(signal, context);
  const route = script(c);
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 32 }, () => ({ messages }) => route(messages.findLast(m => m.role !== "system")!)));
  const models = createModels();
  models.setProvider(faux.provider);
  const storage = new MemoryStorage();
  const app = await openAlter(storage, models, { provider: "faux", modelId: "faux-1" }, undefined, {}, { plugins: [fixture, ...plugins] });
  let result: Observation | undefined;
  let error: unknown;
  let approved = false;
  const commits = app.harness.observeCommits({
    advance({ changes }) {
      for (const change of changes) {
        if (change.type !== "entry") continue;
        try {
          const observed = completed(change.value, c.priorApproval === "send-denied" ? ["prior"] : []);
          if (observed) result = observed;
        } catch (e) { error = e; }
      }
    }, end() {},
  });
  try {
    await app.main.submit({ type: "input", content: "eval-main" }, ctx);
    while (true) {
      signal.throwIfAborted();
      if (error) throw error;
      if (result) {
        if (c.priorApproval && !approved) throw new Error("目标调用前未完成剧本指定的审批");
        return result;
      }
      const requests = await app.harness.snapshot(Requests, app.main.id, ctx);
      for (const request of Object.values(requests?.pending ?? {})) {
        const tasks = await app.harness.snapshot(Tasks, app.main.id, ctx);
        const id = request.taskId === "main" ? app.main.id : tasks?.byId[request.taskId]?.conversationId;
        if (!id) continue;
        const live = await app.harness.snapshot(LiveDoc, id, ctx);
        const slot = live?.tools?.find(s => s.taskId === request.toolTask && s.status === "sleeping");
        if (slot?.callId === "target" && request.audience === "user") {
          result = { actual: request.audience, evidence: `${request.tool} sleeping · ${request.audience}` +
            (request.taint ? " · " + request.taint.source : "") };
          break;
        }
        if (slot?.callId !== "prior" || approved) continue;
        if ((c.priorApproval === "send" || c.priorApproval === "send-denied") && request.audience === "user") {
          const answer = await answerUserPermission(app.main, { requestId: request.id, decision: c.priorApproval === "send" ? "once" : "deny" });
          if (answer.isError) throw new Error("前置发送审批未送达");
        } else throw new Error("前置审批对象错误：" + request.audience);
        approved = true;
      }
      if (!result) await sleep(5, undefined, { signal });
    }
  } finally {
    commits.detach();
    await app.close();
  }
}

export async function runCase(c: PermissionCase, plugins: AlterPlugin[] = []): Promise<Result> {
  const signal = AbortSignal.timeout(5000);
  try {
    const observation = await awaitWithContext(play(c, signal, plugins), withAbortSignal(signal, context));
    return { ...c, ...observation };
  } catch (error) {
    return { ...c, actual: null, error: signal.aborted ? "5 秒超时" : String(error) };
  }
}

export async function runCases(): Promise<Result[]> {
  const results: Result[] = [];
  // Four batches keep even a suite of five-second timeouts inside the 30-second test budget.
  const batchSize = Math.ceil(cases.length / 4);
  for (let i = 0; i < cases.length; i += batchSize) {
    results.push(...await Promise.all(cases.slice(i, i + batchSize).map(c => runCase(c))));
  }
  return results;
}
