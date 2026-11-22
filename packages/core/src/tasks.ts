import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { contentText } from "@earendil-works/pi-ai";
import { calendarTime } from "./calendar-time.ts";
import { addNotification } from "./notifications.ts";
import { Requests } from "./broker.ts";
import type { inputClock } from "./clock.ts";
import type { CapabilityRegistry } from "./capabilities.ts";
import {
  configure, defineExtension, defineTask, defineTool, GenerationTask, hook, hookTask, InboxDoc, LiveDoc, ProviderDoc, reply,
  ROOT_CONVERSATION_ID, SubmissionSettled, type ConversationHandle, type ConversationId, type Cursor, type Harness, type Extension, type ModelRef, type ModelThinkingLevel, type TaskId, type Tx, type YieldDecision,
} from "./runtime.ts";
import { budgetExhausted } from "./usage.ts";
import { inheritTaint } from "./taint.ts";
import { Ledger, TaskIdentity, Tasks, type TaskRecord } from "./state.ts";

const nonempty = str({ minLength: 1 });
const reminder = "Complete the task by calling finish with a summary and refs. Call finish alone.";
const maxReminders = 3;
const workerInstructions = "Carry out the assigned brief. Call tools directly even when they need approval: the system pauses the call " +
  "and asks the approver, so never stop to ask for approval yourself. Request any missing capability. " + reminder;

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
  await main.submit(tx, {
    entry: { kind: "alter.task-report", data: { taskId, at } },
    type: "input", whenBusy: "followUp", requestId: `${failed ? "failure" : "report"}-${taskId}`,
    content: `task ${taskId} ${failed ? "failed" : "finished"}: ${summary}`,
  });
}

const finish = defineTool({
  name: "finish", description: "Complete the task, record references, and report to main. Call this tool alone.",
  parameters: obj({ summary: nonempty, refs: arr(obj({ kind: nonempty, ref: nonempty })) }),
  replay: "safe",
  async execute(args, api, ctx) {
    const { refs } = args;
    const summary = unescapeNewlines(args.summary);
    if ((await api.snapshot(LiveDoc, api.conversationId, ctx))?.tools?.length !== 1) return reply(reminder, true);
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
      await report(tx, main, task, taskId, at, summary);
      ledger.entries.push({ taskId, summary, refs, at });
      task.status = "completed";
      return { ...reply(summary), control: { terminate: true } };
    }, ctx);
  },
});

export const TaskTools = defineExtension({
  name: "alter.task-tools", tasks: [ReviewAnswer],
  hooks: [hook(GenerationTask, { onYield: () => ({ tasks: [hookTask(ReviewAnswer, null)] }) })],
  tools: [finish, defineTool({
    name: "request_capability", description: "Request a capability and explain why it is needed.",
    parameters: obj({ capability: nonempty, reason: nonempty }), replay: "safe",
    async execute({ capability }, api, ctx) {
      await api.commit(async tx => {
        const { taskId } = await tx.doc(TaskIdentity, api.conversationId);
        const task = (await tx.doc(Tasks, ROOT_CONVERSATION_ID)).byId[taskId]!;
        if (task.status === "running" && task.permission === "restricted" && !task.allow.includes(capability)) task.allow.push(capability);
      }, ctx);
      return reply(`Approved: ${capability}`);
    },
  })],
});

async function clearRequests(tx: Tx, mainId: ConversationId, taskId: string) {
  const { pending } = await tx.doc(Requests, mainId);
  for (const request of Object.values(pending)) {
    if (request.taskId === taskId) delete pending[request.id];
  }
}

async function failTask(tx: Tx, main: ConversationHandle, taskId: string, failure: string, at: number, aborted = false) {
  const task = (await tx.doc(Tasks, main.id)).byId[taskId]!;
  if (task.status !== "running") return;
  task.status = "failed";
  task.failure = failure;
  await clearRequests(tx, main.id, taskId);
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

type DispatchArgs = Pick<TaskRecord, "brief" | "context" | "permission" | "allow" | "continuedFrom"> & { thinking?: ModelThinkingLevel };
export function createDispatcher(extensions: Extension[], model: ModelRef, clock: ReturnType<typeof inputClock>,
  resolveThinking: (requested?: ModelThinkingLevel) => ModelThinkingLevel) {
  return async (tx: Tx, mainId: ConversationId, taskId: string, args: DispatchArgs, goal?: TaskRecord["goal"]) => {
    const tasks = await tx.doc(Tasks, mainId);
    if (tasks.byId[taskId]) return;
    const previous = args.continuedFrom ? tasks.byId[args.continuedFrom] : undefined;
    const at = !previous && args.context === "fork" ? await tx.latestEntryId(mainId) : undefined;
    if (previous) {
      const identity = await tx.doc(TaskIdentity, previous.conversationId);
      const latest = tasks.byId[identity.taskId]!;
      if (latest.status === "running") throw new Error(`Conversation is running as ${identity.taskId}; use task_message`);
      const end = await tx.latestEntryId(previous.conversationId);
      if (end !== undefined) latest.lastEntry = end;
    }
    const stamp = clock();
    const worker = await tx.createTask(BackgroundTask, { taskId, timePrefix: stamp.prefix }, {
      ownership: { kind: "conversation" }, background: true,
    });
    const options = { ownership: { kind: "task" as const, taskId: worker } };
    const childId = previous?.conversationId ?? (at === undefined
      ? await tx.createConversation(options) : await tx.forkConversation(mainId, at, options)).id;
    const thinking = resolveThinking(args.thinking);
    await configure(tx, childId, {
      model, thinkingLevel: thinking, extensions, tools: null, modelTools: null, maxTurns: 40,
      instructions: goal ? "完成只读调研后单独调用 finish，提供摘要与引用。" : workerInstructions,
    });
    await inheritTaint(tx, mainId, childId);
    if (goal && !previous) {
      const provider = await tx.doc(ProviderDoc, childId);
      provider.sessionId = `proactive-${provider.sessionId}`;
    }
    const identity = await tx.doc(TaskIdentity, childId);
    identity.taskId = taskId;
    identity.reminders = 0;
    tasks.byId[taskId] = {
      worker, conversationId: childId, brief: args.brief, context: args.context, createdAt: stamp.at, thinking,
      permission: args.permission, allow: [...args.allow], status: "running", ...(goal && { proactive: true, goal: { ...goal } }),
      ...(args.continuedFrom && { continuedFrom: args.continuedFrom }),
    };
  };
}

function lookup<T>(byId: Record<string, T>, id: string) {
  return Object.hasOwn(byId, id) ? byId[id] : undefined;
}

export function dispatchTool({ manifests }: CapabilityRegistry, dispatch: ReturnType<typeof createDispatcher>) {
  return defineTool({
    name: "dispatch_task", description: "Start a task with context, permission and allow. To continue an ended task, supply continue_from instead; it keeps its conversation and permissions.",
    parameters: obj({
      brief: nonempty, context: opt(oneOf(["fork", "fresh"])), permission: opt(oneOf(["restricted", "auto", "full"])),
      allow: opt(arr(nonempty)), continue_from: opt(nonempty), thinking: opt(oneOf(["low", "medium", "high", "max"])),
    }),
    replay: "safe",
    async execute({ brief, context, permission, allow, continue_from, thinking }, api, ctx) {
      const taskId = `task-${api.taskId}`;
      const tasks = (await api.snapshot(Tasks, api.conversationId, ctx))!.byId;
      if (tasks[taskId]) return reply(taskId);
      if (continue_from) {
        const previous = lookup(tasks, continue_from);
        if (!previous) return reply("Unknown task", true);
        if (context || permission || allow) return reply("continue_from inherits context, permission and allow; omit those fields", true);
        const identity = (await api.snapshot(TaskIdentity, previous.conversationId, ctx))!;
        const latest = tasks[identity.taskId]!;
        if (latest.status === "running") return reply(`Task ${identity.taskId} is running; use task_message`, true);
        await api.waitForTask(latest.worker, ctx);
        await api.commit(tx => dispatch(tx, api.conversationId, taskId, { brief, thinking, continuedFrom: continue_from,
          context: previous.context, permission: previous.permission, allow: previous.allow }, previous.goal), ctx);
      } else {
        if (!context || !permission || !allow) return reply("A new task requires context, permission and allow", true);
        if (allow.some(id => !manifests.some(cap => cap.id === id))) return reply("Unknown capability in allow", true);
        await api.commit(tx => dispatch(tx, api.conversationId, taskId, { brief, context, permission, allow, thinking }), ctx);
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
    const requests = Object.values(pending).filter(req => req.taskId === taskId).map(req => ({
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
  const tool = defineTool({
    name: "task_cancel", description: "Stop a running task and withdraw its pending approvals.",
    parameters: obj({ taskId: nonempty }), replay: "safe",
    async execute({ taskId }, api, ctx) {
      const result = await api.commit(async tx => {
        const task = lookup((await tx.doc(Tasks, api.conversationId)).byId, taskId);
        if (!task) return reply("Unknown task", true);
        if (task.status === "running") {
          task.status = "cancelled";
          await clearRequests(tx, api.conversationId, taskId);
          (await tx.doc(Ledger, api.conversationId)).entries.push({ taskId, summary: "cancelled", refs: [], at: api.now() });
          await tx.createTask(stop, task.worker, { ownership: { kind: "conversation" }, background: true });
        }
        return task.status === "cancelled" ? task.worker : reply(`Task already ${task.status}`, true);
      }, ctx);
      if (typeof result !== "number") return result;
      await api.waitForTask(result, ctx);
      return reply(`Task ${taskId}: cancelled`);
    },
  });
  return { tool, stop };
}
