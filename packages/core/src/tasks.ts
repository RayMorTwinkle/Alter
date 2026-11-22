import { arr, obj, oneOf, str } from "@earendil-works/pi-schema";
import { calendarTime } from "./calendar-time.ts";
import { addNotification } from "./notifications.ts";
import { Requests } from "./broker.ts";
import type { inputClock } from "./clock.ts";
import type { CapabilityRegistry } from "./capabilities.ts";
import {
  configure, defineExtension, defineTask, defineTool, GenerationTask, hook, hookTask, LiveDoc, ProviderDoc, reply,
  ROOT_CONVERSATION_ID, SubmissionSettled, type ConversationHandle, type ConversationId, type Extension, type ModelRef, type ModelThinkingLevel, type Tx, type YieldDecision,
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
    await api.commit(async tx => {
      const { taskId } = await tx.doc(TaskIdentity, api.conversationId);
      const task = (await tx.doc(Tasks, main.id)).byId[taskId]!;
      if (task.status === "completed") return;
      const ledger = await tx.doc(Ledger, main.id);
      const at = api.now();
      await report(tx, main, task, taskId, at, summary);
      ledger.entries.push({ taskId, summary, refs, at });
      task.status = "completed";
    }, ctx);
    return { ...reply(summary), control: { terminate: true } };
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
        if (task.permission === "restricted" && !task.allow.includes(capability)) task.allow.push(capability);
      }, ctx);
      return reply(`Approved: ${capability}`);
    },
  })],
});

async function failTask(tx: Tx, main: ConversationHandle, taskId: string, failure: string, at: number, aborted = false) {
  const task = (await tx.doc(Tasks, main.id)).byId[taskId]!;
  if (task.status !== "running") return;
  task.status = "failed";
  task.failure = failure;
  const { pending } = await tx.doc(Requests, main.id);
  for (const request of Object.values(pending)) {
    if (request.taskId === taskId) delete pending[request.id];
  }
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
    await runtime.hooks.each("onTaskEnd", end => end(input.taskId));
    const main = (await runtime.conversation(runtime.conversationId, ctx))!;
    return runtime.commit(async tx => {
      await failTask(tx, main, input.taskId, "aborted", runtime.now(), true);
      return { status: "terminal", outcome: { status: "aborted" } };
    }, ctx);
  },
});

type DispatchArgs = Pick<TaskRecord, "brief" | "context" | "permission" | "allow">;
export function createDispatcher(extensions: Extension[], model: ModelRef, clock: ReturnType<typeof inputClock>, thinkingLevel?: ModelThinkingLevel) {
  return async (tx: Tx, mainId: ConversationId, taskId: string, args: DispatchArgs, goal?: TaskRecord["goal"]) => {
    const tasks = await tx.doc(Tasks, mainId);
    if (tasks.byId[taskId]) return;
    const at = args.context === "fork" ? await tx.latestEntryId(mainId) : undefined;
    const stamp = clock();
    const owner = await tx.createTask(BackgroundTask, { taskId, timePrefix: stamp.prefix }, {
      ownership: { kind: "conversation" }, background: true,
    });
    const options = { ownership: { kind: "task" as const, taskId: owner } };
    const child = at === undefined
      ? await tx.createConversation(options)
      : await tx.forkConversation(mainId, at, options);
    await configure(tx, child.id, {
      model, thinkingLevel, extensions, tools: null, modelTools: null, maxTurns: 40,
      instructions: goal ? "完成只读调研后单独调用 finish，提供摘要与引用。" : workerInstructions,
    });
    await inheritTaint(tx, mainId, child.id);
    if (goal) {
      const provider = await tx.doc(ProviderDoc, child.id);
      provider.sessionId = `proactive-${provider.sessionId}`;
    }
    (await tx.doc(TaskIdentity, child.id)).taskId = taskId;
    tasks.byId[taskId] = {
      conversationId: child.id, brief: args.brief, context: args.context, createdAt: stamp.at,
      permission: args.permission, allow: args.allow, status: "running", ...(goal && { proactive: true, goal }),
    };
  };
}

export function dispatchTool({ manifests }: CapabilityRegistry, dispatch: ReturnType<typeof createDispatcher>) {
  return defineTool({
    name: "dispatch_task", description: "Start a background task. Its report will arrive as a follow-up.",
    parameters: obj({
      brief: nonempty, context: oneOf(["fork", "fresh"]), permission: oneOf(["restricted", "auto", "full"]),
      allow: arr(nonempty),
    }),
    replay: "safe",
    async execute(args, api, ctx) {
      if (args.allow.some(id => !manifests.some(cap => cap.id === id))) return reply("Unknown capability in allow", true);
      const taskId = `task-${api.taskId}`;
      await api.commit(tx => dispatch(tx, api.conversationId, taskId, args), ctx);
      return reply(taskId);
    },
  });
}
