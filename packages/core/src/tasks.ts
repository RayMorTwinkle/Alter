import { arr, obj, oneOf, str } from "@earendil-works/pi-schema";
import { Requests } from "./broker.ts";
import type { CapabilityRegistry } from "./capabilities.ts";
import {
  configure, defineExtension, defineTask, defineTool, GenerationTask, hook, hookTask, LiveDoc, reply,
  ROOT_CONVERSATION_ID, SubmissionSettled, type ConversationId, type Extension, type ModelRef, type ModelThinkingLevel, type Tx, type YieldDecision,
} from "./runtime.ts";
import { inheritTaint } from "./taint.ts";
import { Ledger, TaskIdentity, Tasks } from "./state.ts";

const nonempty = str({ minLength: 1 });
const reminder = "Complete the task by calling finish with a summary and refs. Call finish alone.";
const maxReminders = 3;

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
      await inheritTaint(tx, api.conversationId, main.id);
      await main.submit(tx, {
        entry: { kind: "alter.task-report", data: { taskId, at } },
        type: "input", whenBusy: "followUp", requestId: `report-${taskId}`, content: `task ${taskId} finished: ${summary}`,
      });
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

async function failTask(tx: Tx, mainId: ConversationId, taskId: string, failure: string) {
  const task = (await tx.doc(Tasks, mainId)).byId[taskId]!;
  if (task.status !== "running") return false;
  task.status = "failed";
  task.failure = failure;
  const { pending } = await tx.doc(Requests, mainId);
  for (const request of Object.values(pending)) {
    if (request.taskId === taskId) delete pending[request.id];
  }
  return true;
}

// The background task owns the conversation and sleeps until its brief settles. Main stays available.
export const BackgroundTask = defineTask<{ taskId: string }, { phase: "start" | "settled" }, null, {
  onTaskEnd(taskId: string): Promise<void>;
}>({
  name: "alter.background-task", version: 1, initial: () => ({ phase: "start" }),
  phases: {
    async start({ input }, runtime, ctx) {
      const task = (await runtime.snapshot(Tasks, runtime.conversationId, ctx))!.byId[input.taskId]!;
      const child = (await runtime.conversation(task.conversationId, ctx))!;
      await runtime.commit(async tx => {
        await child.submit(tx, {
          type: "input", content: task.brief, requestId: `brief-${input.taskId}`,
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
        const failure = receipt && "value" in receipt && receipt.value.status === "unanswered"
          ? receipt.value.reason : "No finish after the reminder limit";
        if (await failTask(tx, main.id, input.taskId, failure)) {
          const task = (await tx.doc(Tasks, main.id)).byId[input.taskId]!;
          await inheritTaint(tx, task.conversationId, main.id);
          await main.submit(tx, {
            entry: { kind: "alter.task-report", data: { taskId: input.taskId, at: runtime.now() } },
            type: "input", whenBusy: "followUp", requestId: `failure-${input.taskId}`,
            content: `task ${input.taskId} failed: ${failure}`,
          });
        }
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, ctx);
    },
  },
  async abort({ input }, runtime, ctx) {
    await runtime.hooks.each("onTaskEnd", end => end(input.taskId));
    return runtime.commit(async tx => {
      await failTask(tx, runtime.conversationId, input.taskId, "aborted");
      return { status: "terminal", outcome: { status: "aborted" } };
    }, ctx);
  },
});

export function dispatchTool(
  { manifests }: CapabilityRegistry, taskExtensions: Extension[], taskModel: ModelRef, taskThinking?: ModelThinkingLevel,
) {
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
      await api.commit(async tx => {
        const tasks = await tx.doc(Tasks, api.conversationId);
        if (tasks.byId[taskId]) return;
        const at = args.context === "fork" ? await tx.latestEntryId(api.conversationId) : undefined;
        const owner = await tx.createTask(BackgroundTask, { taskId }, {
          ownership: { kind: "conversation" }, background: true,
        });
        const options = { ownership: { kind: "task" as const, taskId: owner } };
        const child = at === undefined
          ? await tx.createConversation(options)
          : await tx.forkConversation(api.conversationId, at, options);
        await configure(tx, child.id, {
          model: taskModel, thinkingLevel: taskThinking, extensions: taskExtensions, tools: null, modelTools: null, maxTurns: 40,
          instructions: "Carry out the assigned brief. Call tools directly even when they need approval: the system pauses the call " +
            "and asks the approver, so never stop to ask for approval yourself. Request any missing capability. " + reminder,
        });
        await inheritTaint(tx, api.conversationId, child.id);
        (await tx.doc(TaskIdentity, child.id)).taskId = taskId;
        tasks.byId[taskId] = {
          conversationId: child.id, brief: args.brief, context: args.context, createdAt: api.now(),
          permission: args.permission, allow: args.allow, status: "running",
        };
      }, ctx);
      return reply(taskId);
    },
  });
}
