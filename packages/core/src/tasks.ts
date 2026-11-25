import type { TaskEnd } from "@alter/node-protocol";
import { NodeRuns, type NodeRunner } from "./node-state.ts";
import type { NodeHub } from "./nodes.ts";
import { arr, bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { contentText } from "@earendil-works/pi-ai";
import { proactivePrinciple, recordAdoption } from "./heartbeat-state.ts";
import { activeHeartbeat, recentUserText, submitWake } from "./timeline.ts";
import { LeaseHistory, Leases } from "./leases.ts";
import { Audit, Requests, withdrawNodeRequests } from "./broker.ts";
import type { inputClock } from "./clock.ts";
import {
  configure, defineExtension, defineSignal, defineTask, defineTool, GenerationTask, hook, hookTask, InboxDoc, LiveDoc, ProviderDoc, reply,
  ROOT_CONVERSATION_ID, SubmissionSettled, type ConversationHandle, type ConversationId, type Cursor, type Harness, type Extension, type ModelRef, type ModelThinkingLevel, type TaskId, type Tx, type ToolExecutionApi, type Context, type YieldDecision,
} from "./runtime.ts";
import { activeWake, Wakes } from "./wake.ts";
import { budgetExhausted } from "./usage.ts";
import { Ledger, ScopeDoc, TaskIdentity, Tasks, type TaskRecord } from "./state.ts";

const nonempty = str({ minLength: 1 });
const reminder = "Complete the task by calling finish with a summary and refs. Call finish alone.";
const maxReminders = 3;
export const workerInstructions = "Carry out the assigned brief using the enabled plugin tools. " +
  "Call the tool directly; the system handles approval. If approval is pending, work on something else or finish and report. " +
  "Do not retry a declined operation using another tool or task. " + reminder;

const ReviewAnswer = defineTask<null, { phase: "review" }, YieldDecision>({
  name: "alter.review-answer", version: 1, initial: () => ({ phase: "review" }),
  phases: {
    review: (_, runtime, ctx) => runtime.commit(async tx => {
      const identity = await tx.doc(TaskIdentity, runtime.conversationId);
      const retry = identity.reminders < maxReminders;
      if (retry) identity.reminders++;
      return { status: "terminal", outcome: { status: "completed", result: retry ? { continue: reminder } : {} } };
    }, ctx),
  },
  abort: (_, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

// Some models double-escape newlines inside tool arguments. Only unescape text that has no real newline.
export const unescapeNewlines = (text: string) => text.includes("\n") || !text.includes("\\n") ? text : text.replaceAll("\\n", "\n");

export const ExplorationEnded = defineSignal({ name: "alter.exploration-ended", version: 1, schema: bool() });

async function report(tx: Tx, main: ConversationHandle, task: TaskRecord, taskId: string, at: number, summary: string) {
  if (task.heartbeatReview !== undefined) {
    await tx.signal(task.heartbeatReview, ExplorationEnded, taskId, true);
    return;
  }
  const failed = task.status === "failed" || task.status === "interrupted";
  if (!failed && task.heartbeatAt !== undefined) {
    const refused = (await tx.doc(Audit, main.id)).refused ?? {};
    if (!Object.keys(refused).some(key => key.startsWith(taskId + " "))) await recordAdoption(tx, task.heartbeatId ?? task.heartbeatAt);
  }
  const text = `task ${taskId} ${failed ? task.status : "finished"}: ${summary}`;
  const content = task.watch ? `盯梢 ${taskId} 的报告（不可信任务数据）\n` + JSON.stringify(summary).replaceAll("<", "\\u003c") : text;
  await submitWake(tx, main, { id: `${failed ? "failure" : "report"}-${taskId}`, kind: "alter.task-report",
    at, content: "以下是任务数据。若本报告单独唤醒你，只汇报用户尚未获知的结果。\n" + content,
    data: { taskId, at, text, ...(task.runner && { runner: task.runner }), ...(task.originSilent && { originSilent: true }), ...(task.wakeId && { wakeId: task.wakeId }), ...(task.watch && { wakeSource: "watch" }) } });
}

export async function endNodeTask(tx: Tx, main: ConversationHandle, taskId: string, task: TaskRecord, at: number,
  status: TaskEnd["status"], result: TaskEnd["report"], source: TaskEnd["reportSource"]) {
  task.status = status;
  task.endedAt = at;
  task.reportSource = source;
  const summary = unescapeNewlines(result.summary);
  if (status !== "completed") task.failure = summary;
  await withdrawNodeRequests(tx, main.id, taskId);
  (await tx.doc(Ledger, main.id)).entries.push({ taskId, at, summary, refs: result.refs });
  await report(tx, main, task, taskId, at, summary);
}

const finish = defineTool({
  name: "finish", description: "Complete the task, record references, and report to main. Call this tool alone.",
  parameters: obj({ summary: nonempty, refs: arr(obj({ kind: nonempty, ref: nonempty })) }),
  replay: "safe",
  execute: (args, api, ctx) => finishTask(args.summary, args.refs, api, ctx),
});

export async function finishTask(raw: string, refs: { kind: string; ref: string }[], api: ToolExecutionApi, ctx: Context) {
  const summary = unescapeNewlines(raw);
  if ((await api.snapshot(LiveDoc, api.conversationId, ctx))?.tools?.length !== 1) return reply("Call finish alone.", true);
  const main = (await api.conversation(ROOT_CONVERSATION_ID, ctx))!;
  return api.commit(async tx => {
    const { taskId } = await tx.doc(TaskIdentity, api.conversationId);
    const task = (await tx.doc(Tasks, main.id)).byId[taskId]!;
    if (task.status !== "running") return { ...reply(task.status), control: { terminate: true } };
    if ((await tx.doc(InboxDoc, api.conversationId)).items.some(item => item.mode === "steer")) {
      return reply("Read the incoming task message before calling finish.", true);
    }
    const ledger = await tx.doc(Ledger, main.id);
    const at = api.now();
    if (task.watch) task.watch.finished = true;
    await report(tx, main, task, taskId, at, summary);
    ledger.entries.push({ taskId, summary, refs, at });
    task.status = "completed";
    task.endedAt = at;
    return { ...reply(summary), control: { terminate: true } };
  }, ctx);
}

export const TaskTools = defineExtension({
  name: "alter.task-tools", tasks: [ReviewAnswer],
  hooks: [hook(GenerationTask, { onYield: () => ({ tasks: [hookTask(ReviewAnswer, null)] }) })],
  tools: [finish],
});

export async function clearRequests(tx: Tx, mainId: ConversationId, taskId: string, keepDeferred = false) {
  const { pending } = await tx.doc(Requests, mainId);
  for (const request of Object.values(pending)) {
    if (request.taskId === taskId && !(keepDeferred && request.deferred)) delete pending[request.id];
  }
}

async function failTask(tx: Tx, main: ConversationHandle, taskId: string, failure: string, at: number, aborted = false) {
  const task = (await tx.doc(Tasks, main.id)).byId[taskId]!;
  if (task.status !== "running") return;
  task.status = "failed";
  task.endedAt = at;
  task.failure = failure;
  await clearRequests(tx, main.id, taskId, !aborted);
  if (!aborted || task.heartbeatReview !== undefined) await report(tx, main, task, taskId, at, failure);
}

// The background task owns the conversation and sleeps until its brief settles. Main stays available.
export const BackgroundTask = defineTask<{ taskId: string; timePrefix?: string }, { phase: "start" | "settled" }, null, {
  onTaskEnd(taskId: string): Promise<void>;
}>({
  name: "alter.background-task", version: 1, initial: () => ({ phase: "start" }),
  phases: {
    async start({ input }, runtime, ctx) {
      const task = (await runtime.snapshot(Tasks, runtime.conversationId, ctx))!.byId[input.taskId]!;
      const child = (await runtime.conversation(task.conversationId, ctx))!;
      await runtime.commit(async tx => {
        if ((await tx.doc(Tasks, runtime.conversationId)).byId[input.taskId]!.status !== "running") {
          return { status: "terminal", outcome: { status: "aborted" } };
        }
        await child.submit(tx, {
          type: "input", content: input.timePrefix ? input.timePrefix + "\n" + task.brief : task.brief,
          entry: { kind: "alter.task-brief", data: { text: task.brief } }, requestId: `brief-${input.taskId}`,
          notify: { taskId: runtime.taskId, key: "settled" },
        });
        return { status: "sleeping", checkpoint: { phase: "settled" }, signals: [SubmissionSettled.key("settled")] };
      }, ctx);
    },
    async settled({ input }, runtime, ctx) {
      const receipt = await runtime.readSignal(SubmissionSettled, "settled", ctx);
      const main = (await runtime.conversation(runtime.conversationId, ctx))!;
      const task = (await runtime.snapshot(Tasks, main.id, ctx))!.byId[input.taskId]!;
      const child = (await runtime.conversation(task.conversationId, ctx))!;
      // A steering input at a final-answer boundary can start a successor run.
      await child.waitForIdle(ctx);
      await runtime.hooks.each("onTaskEnd", end => end(input.taskId));
      await runtime.commit(async tx => {
        const unanswered = receipt && "value" in receipt && receipt.value.status === "unanswered" ? receipt.value : undefined;
        const failure = unanswered?.detail === budgetExhausted ? budgetExhausted : unanswered?.reason ?? "No finish after the reminder limit";
        await failTask(tx, main, input.taskId, failure, runtime.now());
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, ctx);
    },
  },
  async abort({ input }, runtime, ctx) {
    const task = (await runtime.snapshot(Tasks, runtime.conversationId, ctx))!.byId[input.taskId]!;
    // Ownership of a reused conversation still points to its original worker.
    if (task.continuedFrom) await (await runtime.conversation(task.conversationId, ctx))!.abort(ctx);
    await runtime.hooks.each("onTaskEnd", end => end(input.taskId));
    const main = (await runtime.conversation(runtime.conversationId, ctx))!;
    return runtime.commit(async tx => {
      await failTask(tx, main, input.taskId, "aborted", runtime.now(), true);
      return { status: "terminal", outcome: { status: "aborted" } };
    }, ctx);
  },
});

type DispatchArgs = Pick<TaskRecord, "runner" | "cwd" | "brief" | "context" | "permission" | "continuedFrom" | "triggerSource" | "heartbeatId"> & { thinking?: ModelThinkingLevel };
export function createDispatcher(extensions: Extension[], model: ModelRef, clock: ReturnType<typeof inputClock>,
  resolveThinking: (requested?: ModelThinkingLevel) => ModelThinkingLevel, nodes: NodeHub) {
  return async (tx: Tx, mainId: ConversationId, taskId: string, args: DispatchArgs,
    watch?: { createWorker: () => Promise<TaskId>; settings: NonNullable<TaskRecord["watch"]>; tools: Extension; instructions: string }) => {
    const tasks = await tx.doc(Tasks, mainId);
    if (tasks.byId[taskId]) return;
    const stamp = clock();
    const inputs = await recentUserText(tx, mainId, stamp.at);
    const wake = !args.triggerSource ? await activeWake(tx, mainId, stamp.at) : undefined;
    const originSilent = wake && (await tx.doc(Wakes, mainId)).silent?.[wake.wakeId];
    const inspection = args.heartbeatId ? { heartbeatId: args.heartbeatId, heartbeatAt: stamp.at } :
      args.triggerSource ? undefined : await activeHeartbeat(tx, mainId);
    const brief = inspection && !args.heartbeatId ? args.brief + "\n" + proactivePrinciple : args.brief;
    const previous = args.continuedFrom ? tasks.byId[args.continuedFrom] : undefined;
    const goal = previous?.goal; // Preserve read-only scope when resuming historical research.
    const runner = previous?.runner ?? args.runner;
    const at = !runner && !previous && args.context === "fork" ? await tx.latestEntryId(mainId) : undefined;
    if (previous) {
      const identity = await tx.doc(TaskIdentity, previous.conversationId);
      const latest = tasks.byId[identity.taskId]!;
      if (latest.status === "running" || latest.status === "queued") throw new Error(`Conversation is running as ${identity.taskId}; use task_message`);
      const end = await tx.latestEntryId(previous.conversationId);
      if (end !== undefined) latest.lastEntry = end;
    }
    const worker = runner ? await tx.createTask(nodes.worker, runner.node, { ownership: { kind: "conversation" }, background: true })
      : watch ? await watch.createWorker() : await tx.createTask(BackgroundTask, { taskId, timePrefix: stamp.prefix }, {
      ownership: { kind: "conversation" }, background: true,
    });
    const options = { ownership: { kind: "task" as const, taskId: worker } };
    const childId = previous?.conversationId ?? (at === undefined
      ? await tx.createConversation(options) : await tx.forkConversation(mainId, at, options)).id;
    const thinking = runner ? args.thinking ?? previous?.thinking ?? "high" : resolveThinking(args.thinking);
    if (!runner) await configure(tx, childId, {
      model, thinkingLevel: thinking, tools: null, modelTools: null, maxTurns: 40,
      extensions: watch ? extensions.map(ext => ext === TaskTools ? watch.tools : ext) : extensions,
      ...(watch ? { compaction: { enabled: false } } : previous?.watch ? { compaction: null } : {}),
      instructions: watch?.instructions ?? (goal ? "完成只读调研后单独调用 finish，提供摘要与引用。" : workerInstructions),
    });
    if (inspection || previous?.heartbeatAt !== undefined) {
      const provider = await tx.doc(ProviderDoc, childId);
      const session = provider.sessionId.replace(/^heartbeat-/, "");
      provider.sessionId = inspection ? "heartbeat-" + session : session;
    }
    const identity = await tx.doc(TaskIdentity, childId);
    const scope = await tx.doc(ScopeDoc, childId);
    scope.items = inputs ? [...inputs.map(purpose => ({ tool: "", target: "", purpose })),
      { tool: "", target: "任务 brief", purpose: brief }] : [];
    if (previous) {
      scope.late = [];
      delete scope.capabilities;
      delete scope.shown;
    }
    const scheduled = args.triggerSource === "scheduled" || wake?.wakeSource === "schedule";
    if (scheduled) identity.scheduled = true;
    else delete identity.scheduled;
    delete identity.watchWakeId;
    identity.taskId = taskId;
    if (wake) identity.wakeId = wake.wakeId;
    else delete identity.wakeId;
    identity.reminders = 0;
    const cwd = args.cwd ?? previous?.cwd;
    const permission = inspection && args.permission === "full" ? "restricted" : args.permission;
    if (runner) {
      const runs = await tx.doc(NodeRuns, childId);
      runs.byId[taskId] = { ackSeq: 0, messages: [], approvals: {}, start: {
        type: "task.start", taskId, harness: runner.harness, brief, permission,
        ...(cwd && { cwd }), ...(previous?.nativeSessionId && { resume: previous.nativeSessionId }),
        ...(thinking === "low" || thinking === "medium" || thinking === "high" || thinking === "max" ? { thinking } : {}),
      } };
      await tx.appendEntry(childId, { kind: "alter.node-event", data: { kind: "user", at: stamp.at, text: args.brief } });
    }
    tasks.byId[taskId] = {
      ...(runner && { runner }), ...(cwd && { cwd }), worker, ...(originSilent && { originSilent: true }), ...(scheduled && { triggerSource: "scheduled" }), ...(watch && { watch: watch.settings }),
      ...(wake && { wakeId: wake.wakeId }), conversationId: childId, brief, context: args.context, createdAt: stamp.at, thinking,
      permission, status: runner ? "queued" : "running",
      ...inspection, ...(goal && { proactive: true, goal: { ...goal } }),
      ...(args.continuedFrom && { continuedFrom: args.continuedFrom }),
    };
  };
}

function lookup<T>(byId: Record<string, T>, id: string) {
  return Object.hasOwn(byId, id) ? byId[id] : undefined;
}

export function dispatchTool(dispatch: ReturnType<typeof createDispatcher>, nodes: NodeHub) {
  return defineTool({
    name: "dispatch_task", description: "Start a task with context and permission. For a node runner, include the necessary context in brief and optionally specify cwd on that node. To continue an ended task, supply continue_from instead; it keeps its conversation.",
    parameters: obj({
      brief: nonempty, context: opt(oneOf(["fork", "fresh"])), permission: opt(oneOf(["restricted", "auto", "full"])),
      runner: opt(obj({ node: nonempty, harness: oneOf(["claude-code", "codex", "opencode"]) })), cwd: opt(nonempty),
      continue_from: opt(nonempty), thinking: opt(oneOf(["low", "medium", "high", "max"])),
    }),
    replay: "safe",
    async execute({ brief, context, permission, continue_from, thinking, runner, cwd }, api, ctx) {
      const taskId = `task-${api.taskId}`;
      const tasks = (await api.snapshot(Tasks, api.conversationId, ctx))!.byId;
      const receipt = (queued: boolean) => reply(queued ? taskId + " 已排队，电脑上线后开始" : taskId);
      if (tasks[taskId]) return receipt(tasks[taskId].status === "queued");
      let target: NodeRunner | undefined;
      if (continue_from) {
        const previous = lookup(tasks, continue_from);
        if (!previous) return reply("Unknown task", true);
        if (context || permission || runner) return reply("continue_from inherits context, permission and runner; omit those fields", true);
        target = previous.runner;
        const identity = (await api.snapshot(TaskIdentity, previous.conversationId, ctx))!;
        const latest = tasks[identity.taskId]!;
        if (latest.status === "running" || latest.status === "queued") return reply(`Task ${identity.taskId} is running; use task_message`, true);
        if (target && !previous.nativeSessionId) return reply("Node task has no native session to resume", true);
        await api.waitForTask(latest.worker, ctx);
        context = previous.context;
        permission = previous.permission;
      }
      if (!context || !permission) return reply("A new task requires context and permission", true);
      if (cwd && !runner && !target) return reply("cwd requires a node runner", true);
      const result = await api.commit(async tx => {
        if (runner || target) {
          const name = (runner ?? target)!.node;
          const node = (await nodes.list(tx)).find(n => n.id === name || n.name === name);
          if (!node) return reply("Unknown node: " + name, true);
          target = { node: node.id, harness: (runner ?? target)!.harness };
        }
        const args = { brief, thinking, context: context!, permission: permission!, continuedFrom: continue_from, runner: target, cwd };
        await dispatch(tx, api.conversationId, taskId, args);
        const leases = await tx.doc(Leases, api.conversationId);
        const history = await tx.doc(LeaseHistory, api.conversationId);
        for (const id of Object.values(leases.records ?? {})) history.byId[id]!.dispatched = true;
      }, ctx);
      if (result) return result;
      if (target) {
        await nodes.flush(target.node);
        return receipt((await api.snapshot(Tasks, api.conversationId, ctx))!.byId[taskId]!.status === "queued");
      }
      return reply(taskId);
    },
  });
}

const clip = (value: string, limit: number) => value.length <= limit ? value : value.slice(0, limit - 1) + "…";

async function taskActivity(tx: Tx, taskId: string, task: TaskRecord) {
  if (task.runner) {
    const run = (await tx.doc(NodeRuns, task.conversationId)).byId[taskId]!;
    return { latestMessage: run.latestText && { source: taskId, text: run.latestText }, latestTool: run.latestTool };
  }
  const first = (await tx.submissionByRequest(task.conversationId, `brief-${taskId}`))?.entry;
  let latestMessage: { source: string; text: string } | undefined;
  let latestTool: { name: string; arguments: string } | undefined;
  let cursor: Cursor | undefined;
  if (first === undefined) return {};
  do {
    const page = await tx.scanEntries({ conversationId: task.conversationId, minEntryId: first, maxEntryId: task.lastEntry }, 32, cursor);
    for (const entry of page.items) {
      for (const msg of (entry.model ?? []).toReversed()) {
        if (msg.role !== "assistant") continue;
        const text = contentText(msg.content);
        if (!latestMessage && text) latestMessage = { source: taskId, text: clip(text, 300) };
        const tool = msg.content.findLast(part => part.type === "toolCall");
        if (!latestTool && tool) latestTool = { name: tool.name, arguments: clip(JSON.stringify(tool.arguments), 200) };
      }
    }
    cursor = page.next;
  } while (cursor && !(latestMessage && latestTool));
  return { latestMessage, latestTool };
}

export const taskStatus = defineTool({
  name: "task_status", description: "List tasks, or inspect one task's latest assistant text, tool call and pending approvals.",
  parameters: obj({ taskId: opt(nonempty) }), replay: "safe",
  execute: ({ taskId }, api, ctx) => api.commit(async tx => {
    const tasks = (await tx.doc(Tasks, api.conversationId)).byId;
    const summary = (id: string, task: TaskRecord) => ({
      taskId: id, status: task.status, ...(task.runner && { runner: task.runner, cwd: task.cwd,
        nativeSessionId: task.nativeSessionId, reportSource: task.reportSource }), brief: clip(task.brief, 200), thinking: task.thinking,
      ...(task.continuedFrom && { continuedFrom: task.continuedFrom }),
    });
    if (!taskId) return reply(JSON.stringify(Object.entries(tasks).map(([id, task]) => summary(id, task))));
    const task = lookup(tasks, taskId);
    if (!task) return reply("Unknown task", true);
    const { pending } = await tx.doc(Requests, api.conversationId);
    const requests = Object.values(pending).filter(req => req.taskId === taskId && !req.checking).map(req => ({
      id: req.id, audience: req.audience, tool: req.tool, arguments: clip(req.argumentsJson, 200),
      remainingMs: Math.max(0, req.expiresAt - api.now()),
    }));
    const activity = await taskActivity(tx, taskId, task);
    const failure = task.failure && clip(task.failure, 200);
    return reply(JSON.stringify({ ...summary(taskId, task), ...activity, failure, pending: requests }));
  }, ctx),
});

export const taskMessage = (nodes: NodeHub) => defineTool({
  name: "task_message", description: "Send a steering message for the running task's next model turn.",
  parameters: obj({ taskId: nonempty, message: nonempty }), replay: "safe",
  async execute({ taskId, message }, api, ctx) {
    const task = lookup((await api.snapshot(Tasks, api.conversationId, ctx))!.byId, taskId);
    if (!task) return reply("Unknown task", true);
    const child = (await api.conversation(task.conversationId, ctx))!;
    const requestId = `message-${api.taskId}`;
    if (task.runner) {
      const result = await api.commit(async tx => {
        const run = (await tx.doc(NodeRuns, child.id)).byId[taskId]!;
        if (run.messages.some(m => m.id === requestId)) return reply("Message queued");
        const current = (await tx.doc(Tasks, api.conversationId)).byId[taskId]!;
        if (current.status !== "queued" && current.status !== "running") return reply("Task has ended", true);
        run.messages.push({ id: requestId, text: message });
        await tx.appendEntry(child.id, { kind: "alter.node-event", data: { kind: "user", text: message, at: api.now() } });
        return reply("Message queued");
      }, ctx);
      await nodes.flush(task.runner.node);
      return result;
    }
    return api.commit(async tx => {
      if (await tx.submissionByRequest(child.id, requestId)) return reply("Message queued");
      const record = (await tx.doc(Tasks, api.conversationId)).byId[taskId]!;
      if (record.status !== "running") return reply("Task has ended; use dispatch_task with continue_from", true);
      if (task.watch && !(await tx.doc(LiveDoc, child.id)).run) return reply("Watch is sleeping", true);
      if (!await tx.submissionByRequest(child.id, `brief-${taskId}`)) return { sleep: { until: api.now() + 10 } };
      if (!(await tx.doc(LiveDoc, child.id)).run) return reply("Task has ended; use dispatch_task with continue_from", true);
      await child.submit(tx, { type: "input", whenBusy: "steer", whenIdle: "reject", content: message,
        requestId, entry: { kind: "alter.task-message", data: { taskId } } });
      record.messages ??= [];
      record.messages.push({ text: message, at: api.now() });
      return reply("Message queued");
    }, ctx);
  },
});

export function createTaskCancellation(host: () => Harness, nodes: NodeHub) {
  // Persist the stop alongside its receipt so aborting the main turn cannot interrupt cleanup.
  const stop = defineTask<TaskId, { phase: "stop" }, null>({
    name: "alter.stop-task", version: 1, initial: () => ({ phase: "stop" }),
    phases: {
      async stop({ input }, runtime, ctx) {
        await host().abortTask(input, ctx);
        await runtime.waitForTask(input, ctx);
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
      },
    },
    abort: (_, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  async function cancel(tx: Tx, taskId: string, at: number, watchOnly = false) {
    const task = lookup((await tx.doc(Tasks, ROOT_CONVERSATION_ID)).byId, taskId);
    if (!task || (watchOnly && !task.watch)) return reply("Unknown task", true);
    if (task.status === "running") {
      if (task.heartbeatReview !== undefined) await tx.signal(task.heartbeatReview, ExplorationEnded, taskId, true);
      task.status = "cancelled";
      task.endedAt = at;
      await clearRequests(tx, ROOT_CONVERSATION_ID, taskId);
      (await tx.doc(Ledger, ROOT_CONVERSATION_ID)).entries.push({ taskId, summary: "cancelled", refs: [], at });
      await tx.createTask(stop, task.worker, { ownership: { kind: "conversation" }, background: true });
    }
    return task.status === "cancelled" ? task.worker : reply(`Task already ${task.status}`, true);
  }
  const tool = defineTool({
    name: "task_stop", description: "Interrupt a running task and withdraw pending approvals. Resume its conversation later with continue_from.",
    parameters: obj({ taskId: nonempty }), replay: "safe",
    async execute({ taskId }, api, ctx) {
      const task = lookup((await api.snapshot(Tasks, api.conversationId, ctx))!.byId, taskId);
      if (task?.runner) {
        const main = (await api.conversation(ROOT_CONVERSATION_ID, ctx))!;
        const result = await api.commit(async tx => {
          const current = (await tx.doc(Tasks, main.id)).byId[taskId]!;
          if (current.status === "queued") {
            await endNodeTask(tx, main, taskId, current, api.now(), "interrupted", { summary: "已取消排队任务", refs: [] }, "failure");
            return reply("已取消排队任务");
          }
          if (current.status !== "running") return reply("Task already " + current.status, true);
          (await tx.doc(NodeRuns, current.conversationId)).byId[taskId]!.stopping = true;
          await withdrawNodeRequests(tx, main.id, taskId);
          return reply("已请求节点停止任务");
        }, ctx);
        await nodes.flush(task.runner.node);
        return result;
      }
      const result = await api.commit(tx => cancel(tx, taskId, api.now()), ctx);
      if (typeof result !== "number") return result;
      await api.waitForTask(result, ctx);
      return reply(`Task ${taskId}: stopped. Resume with dispatch_task using continue_from.`);
    },
  });
  return { tool, stop, cancel };
}
