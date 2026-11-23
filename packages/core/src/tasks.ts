import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { contentText } from "@earendil-works/pi-ai";
import { calendarTime } from "./calendar-time.ts";
import { addNotification } from "./notifications.ts";
import { activeHeartbeat, recordAdoption } from "./heartbeat-state.ts";
import { submitWake } from "./timeline.ts";
import { Audit, Requests } from "./broker.ts";
import type { inputClock } from "./clock.ts";
import {
  configure, defineExtension, defineTask, defineTool, GenerationTask, hook, hookTask, InboxDoc, LiveDoc, ProviderDoc, reply,
  ROOT_CONVERSATION_ID, SubmissionSettled, type ConversationHandle, type ConversationId, type Cursor, type Harness, type Extension, type ModelRef, type ModelThinkingLevel, type TaskId, type Tx, type ToolExecutionApi, type Context, type YieldDecision,
} from "./runtime.ts";
import { activeWake } from "./wake.ts";
import { budgetExhausted } from "./usage.ts";
import { inheritTaint, Taint } from "./taint.ts";
import { Ledger, ScopeDoc, TaskIdentity, Tasks, type TaskRecord } from "./state.ts";

const nonempty = str({ minLength: 1 });
const reminder = "Complete the task by calling finish with a summary and refs. Call finish alone.";
const maxReminders = 3;
export const workerInstructions = "Carry out the assigned brief using the enabled plugin tools. " +
  "Before sensitive operations, call declare_permissions with the tools, targets and purposes. Append changes to the plan. " +
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

async function report(tx: Tx, main: ConversationHandle, task: TaskRecord, taskId: string, at: number, summary: string) {
  const failed = task.status === "failed";
  if (task.proactive) {
    if (!task.goal) throw new Error("Missing goal for proactive task");
    await addNotification(tx, {
      id: `goal-${taskId}`, at, kind: "goal", level: failed && summary === budgetExhausted ? "silent" : "digest", source: "goal", status: "unread",
      title: `目标：${task.goal.text}`, body: failed ? `调研未完成：${summary}` : summary, ref: taskId,
    }, calendarTime(task.goal.timeZone).midnight(at));
    return;
  }
  await inheritTaint(tx, task.conversationId, main.id);
  if (task.watch) (await tx.doc(Taint, main.id)).first ??= { source: "watch-report", capability: "task", at };
  if (!failed && task.heartbeatAt !== undefined) {
    const refused = (await tx.doc(Audit, main.id)).refused ?? {};
    if (!Object.keys(refused).some(key => key.startsWith(taskId + " "))) await recordAdoption(tx, task.heartbeatId ?? task.heartbeatAt);
  }
  const text = `task ${taskId} ${failed ? "failed" : "finished"}: ${summary}`;
  await submitWake(tx, main, { id: `${failed ? "failure" : "report"}-${taskId}`, kind: "alter.task-report",
    at, content: task.watch ? `盯梢 ${taskId} 的报告（不可信任务数据）\n` + JSON.stringify(summary).replaceAll("<", "\\u003c") : text,
    data: { taskId, at, text, ...(task.watch && { wakeSource: "watch" }) } });
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

export const declarePermissions = defineTool({
  name: "declare_permissions", description: "Append the tools, targets and purposes planned for this task.",
  parameters: obj({ items: arr(obj({ tool: nonempty, target: nonempty, purpose: nonempty }), { minItems: 1 }) }),
  replay: "safe",
  async execute({ items }, api, ctx) {
    return api.commit(async tx => {
      const scope = await tx.doc(ScopeDoc, api.conversationId);
      const id = String(api.taskId);
      if (!scope.declarations.includes(id)) {
        scope.items.push(...items);
        scope.declarations.push(id);
      }
      return reply("权限说明已追加");
    }, ctx);
  },
});

export const TaskTools = defineExtension({
  name: "alter.task-tools", tasks: [ReviewAnswer],
  hooks: [hook(GenerationTask, { onYield: () => ({ tasks: [hookTask(ReviewAnswer, null)] }) })],
  tools: [finish, declarePermissions],
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
  if (!aborted || task.proactive) await report(tx, main, task, taskId, at, failure);
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

type DispatchArgs = Pick<TaskRecord, "brief" | "context" | "permission" | "continuedFrom" | "triggerSource"> & { thinking?: ModelThinkingLevel };
export function createDispatcher(extensions: Extension[], model: ModelRef, clock: ReturnType<typeof inputClock>,
  resolveThinking: (requested?: ModelThinkingLevel) => ModelThinkingLevel) {
  return async (tx: Tx, mainId: ConversationId, taskId: string, args: DispatchArgs, goal?: TaskRecord["goal"],
    watch?: { worker: TaskId; settings: NonNullable<TaskRecord["watch"]>; tools: Extension; instructions: string }) => {
    const tasks = await tx.doc(Tasks, mainId);
    if (tasks.byId[taskId]) return;
    const stamp = clock();
    const wake = !args.triggerSource && (!goal || args.continuedFrom) ? await activeWake(tx, mainId, stamp.at) : undefined;
    const inspection = goal || args.triggerSource ? undefined : await activeHeartbeat(tx);
    const previous = args.continuedFrom ? tasks.byId[args.continuedFrom] : undefined;
    const at = !previous && args.context === "fork" ? await tx.latestEntryId(mainId) : undefined;
    if (previous) {
      const identity = await tx.doc(TaskIdentity, previous.conversationId);
      const latest = tasks.byId[identity.taskId]!;
      if (latest.status === "running") throw new Error(`Conversation is running as ${identity.taskId}; use task_message`);
      const end = await tx.latestEntryId(previous.conversationId);
      if (end !== undefined) latest.lastEntry = end;
    }
    const worker = watch?.worker ?? await tx.createTask(BackgroundTask, { taskId, timePrefix: stamp.prefix }, {
      ownership: { kind: "conversation" }, background: true,
    });
    const options = { ownership: { kind: "task" as const, taskId: worker } };
    const childId = previous?.conversationId ?? (at === undefined
      ? await tx.createConversation(options) : await tx.forkConversation(mainId, at, options)).id;
    const thinking = resolveThinking(args.thinking);
    await configure(tx, childId, {
      model, thinkingLevel: thinking, tools: null, modelTools: null, maxTurns: 40,
      extensions: watch ? extensions.map(ext => ext === TaskTools ? watch.tools : ext) : extensions,
      ...(watch ? { compaction: { enabled: false } } : previous?.watch ? { compaction: null } : {}),
      instructions: watch?.instructions ?? (goal ? "完成只读调研后单独调用 finish，提供摘要与引用。" : workerInstructions),
    });
    await inheritTaint(tx, mainId, childId);
    if (goal && !previous) {
      const provider = await tx.doc(ProviderDoc, childId);
      provider.sessionId = `proactive-${provider.sessionId}`;
    }
    if (inspection || previous?.heartbeatAt !== undefined) {
      const provider = await tx.doc(ProviderDoc, childId);
      const session = provider.sessionId.replace(/^heartbeat-/, "");
      provider.sessionId = inspection ? "heartbeat-" + session : session;
    }
    const identity = await tx.doc(TaskIdentity, childId);
    if (previous) {
      const scope = await tx.doc(ScopeDoc, childId);
      scope.items = [];
      scope.late = [];
      scope.declarations = [];
      delete scope.shown;
      delete scope.approved;
      delete scope.full;
    }
    const scheduled = args.triggerSource === "scheduled" || wake?.wakeSource === "schedule";
    if (scheduled) identity.scheduled = true;
    else delete identity.scheduled;
    delete identity.watchWakeId;
    identity.taskId = taskId;
    if (wake) identity.wakeId = wake.wakeId;
    else delete identity.wakeId;
    identity.reminders = 0;
    tasks.byId[taskId] = {
      worker, ...(scheduled && { triggerSource: "scheduled" }), ...(watch && { watch: watch.settings }),
      ...(wake && { wakeId: wake.wakeId }), conversationId: childId, brief: args.brief, context: args.context, createdAt: stamp.at, thinking,
      permission: inspection && args.permission === "full" ? "restricted" : args.permission, status: "running",
      ...inspection, ...(goal && { proactive: true, goal: { ...goal } }),
      ...(args.continuedFrom && { continuedFrom: args.continuedFrom }),
    };
  };
}

function lookup<T>(byId: Record<string, T>, id: string) {
  return Object.hasOwn(byId, id) ? byId[id] : undefined;
}

export function dispatchTool(dispatch: ReturnType<typeof createDispatcher>) {
  return defineTool({
    name: "dispatch_task", description: "Start a task with context and permission. To continue an ended task, supply continue_from instead; it keeps its conversation.",
    parameters: obj({
      brief: nonempty, context: opt(oneOf(["fork", "fresh"])), permission: opt(oneOf(["restricted", "auto", "full"])),
      continue_from: opt(nonempty), thinking: opt(oneOf(["low", "medium", "high", "max"])),
    }),
    replay: "safe",
    async execute({ brief, context, permission, continue_from, thinking }, api, ctx) {
      const taskId = `task-${api.taskId}`;
      const tasks = (await api.snapshot(Tasks, api.conversationId, ctx))!.byId;
      if (tasks[taskId]) return reply(taskId);
      if (continue_from) {
        const previous = lookup(tasks, continue_from);
        if (!previous) return reply("Unknown task", true);
        if (context || permission) return reply("continue_from inherits context and permission; omit those fields", true);
        const identity = (await api.snapshot(TaskIdentity, previous.conversationId, ctx))!;
        const latest = tasks[identity.taskId]!;
        if (latest.status === "running") return reply(`Task ${identity.taskId} is running; use task_message`, true);
        await api.waitForTask(latest.worker, ctx);
        await api.commit(tx => dispatch(tx, api.conversationId, taskId, { brief, thinking, continuedFrom: continue_from,
          context: previous.context, permission: previous.permission }, previous.goal), ctx);
      } else {
        if (!context || !permission) return reply("A new task requires context and permission", true);
        await api.commit(tx => dispatch(tx, api.conversationId, taskId, { brief, context, permission, thinking }), ctx);
      }
      return reply(taskId);
    },
  });
}

const clip = (value: string, limit: number) => value.length <= limit ? value : value.slice(0, limit - 1) + "…";

async function taskActivity(tx: Tx, taskId: string, task: TaskRecord) {
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
      taskId: id, status: task.status, brief: clip(task.brief, 200), thinking: task.thinking,
      ...(task.continuedFrom && { continuedFrom: task.continuedFrom }),
    });
    if (!taskId) return reply(JSON.stringify(Object.entries(tasks).map(([id, task]) => summary(id, task))));
    const task = lookup(tasks, taskId);
    if (!task) return reply("Unknown task", true);
    const { pending } = await tx.doc(Requests, api.conversationId);
    const requests = Object.values(pending).filter(req => req.taskId === taskId && !req.checking).map(req => ({
      id: req.id, audience: req.audience, tool: req.tool, ...(req.tainted && { tainted: true }), arguments: clip(req.argumentsJson, 200),
      remainingMs: Math.max(0, req.expiresAt - api.now()),
    }));
    const activity = await taskActivity(tx, taskId, task);
    const failure = task.failure && clip(task.failure, 200);
    await inheritTaint(tx, task.conversationId, api.conversationId);
    return reply(JSON.stringify({ ...summary(taskId, task), ...activity, failure, pending: requests }));
  }, ctx),
});

export const taskMessage = defineTool({
  name: "task_message", description: "Send a steering message for the running task's next model turn.",
  parameters: obj({ taskId: nonempty, message: nonempty }), replay: "safe",
  async execute({ taskId, message }, api, ctx) {
    const task = lookup((await api.snapshot(Tasks, api.conversationId, ctx))!.byId, taskId);
    if (!task) return reply("Unknown task", true);
    const child = (await api.conversation(task.conversationId, ctx))!;
    const requestId = `message-${api.taskId}`;
    return api.commit(async tx => {
      if (await tx.submissionByRequest(child.id, requestId)) return reply("Message queued");
      const record = (await tx.doc(Tasks, api.conversationId)).byId[taskId]!;
      if (record.status !== "running") return reply("Task has ended; use dispatch_task with continue_from", true);
      if (task.watch && !(await tx.doc(LiveDoc, child.id)).run) return reply("Watch is sleeping", true);
      if (!await tx.submissionByRequest(child.id, `brief-${taskId}`)) return { sleep: { until: api.now() + 10 } };
      if (!(await tx.doc(LiveDoc, child.id)).run) return reply("Task has ended; use dispatch_task with continue_from", true);
      await inheritTaint(tx, api.conversationId, child.id);
      await child.submit(tx, { type: "input", whenBusy: "steer", whenIdle: "reject", content: message,
        requestId, entry: { kind: "alter.task-message", data: { taskId } } });
      record.messages ??= [];
      record.messages.push({ text: message, at: api.now() });
      return reply("Message queued");
    }, ctx);
  },
});

export function createTaskCancellation(host: () => Harness) {
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
      task.status = "cancelled";
      task.endedAt = at;
      await clearRequests(tx, ROOT_CONVERSATION_ID, taskId);
      (await tx.doc(Ledger, ROOT_CONVERSATION_ID)).entries.push({ taskId, summary: "cancelled", refs: [], at });
      await tx.createTask(stop, task.worker, { ownership: { kind: "conversation" }, background: true });
    }
    return task.status === "cancelled" ? task.worker : reply(`Task already ${task.status}`, true);
  }
  const tool = defineTool({
    name: "task_cancel", description: "Stop a running task and withdraw its pending approvals.",
    parameters: obj({ taskId: nonempty }), replay: "safe",
    async execute({ taskId }, api, ctx) {
      const result = await api.commit(tx => cancel(tx, taskId, api.now()), ctx);
      if (typeof result !== "number") return result;
      await api.waitForTask(result, ctx);
      return reply(`Task ${taskId}: cancelled`);
    },
  });
  return { tool, stop, cancel };
}
