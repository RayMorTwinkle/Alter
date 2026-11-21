import { arr, obj, oneOf, str } from "@earendil-works/pi-schema";
import { Requests } from "./broker.ts";
import { manifests } from "./capabilities.ts";
import {
  configure, defineExtension, defineTask, defineTool, GenerationTask, hook, hookTask, LiveDoc, reply,
  ROOT_CONVERSATION_ID, SubmissionSettled, type ConversationId, type Extension, type ModelRef, type Tx, type YieldDecision,
} from "./runtime.ts";
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

const finish = defineTool({
  name: "finish", description: "Complete the task, record references, and report to main. Call this tool alone.",
  parameters: obj({ summary: nonempty, refs: arr(obj({ kind: nonempty, ref: nonempty })) }),
  replay: "safe",
  async execute({ summary, refs }, api, ctx) {
    if ((await api.snapshot(LiveDoc, api.conversationId, ctx))?.tools?.length !== 1) return reply(reminder, true);
    const main = (await api.conversation(ROOT_CONVERSATION_ID, ctx))!;
    await api.commit(async tx => {
      const { taskId } = await tx.doc(TaskIdentity, api.conversationId);
      const task = (await tx.doc(Tasks, main.id)).byId[taskId]!;
      if (task.status === "completed") return;
      const ledger = await tx.doc(Ledger, main.id);
      await main.submit(tx, {
        type: "input", whenBusy: "followUp", requestId: `report-${taskId}`, content: `task ${taskId} finished: ${summary}`,
      });
      ledger.entries.push({ taskId, summary, refs, at: api.now() });
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
export const BackgroundTask = defineTask<{ taskId: string }, { phase: "start" | "settled" }, null>({
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
      await runtime.commit(async tx => {
        const failure = receipt && "value" in receipt && receipt.value.status === "unanswered"
          ? receipt.value.reason : "No finish after the reminder limit";
        if (await failTask(tx, main.id, input.taskId, failure)) {
          await main.submit(tx, {
            type: "input", whenBusy: "followUp", requestId: `failure-${input.taskId}`,
            content: `task ${input.taskId} failed: ${failure}`,
          });
        }
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, ctx);
    },
  },
  abort: ({ input }, runtime, ctx) => runtime.commit(async tx => {
    await failTask(tx, runtime.conversationId, input.taskId, "aborted");
    return { status: "terminal", outcome: { status: "aborted" } };
  }, ctx),
});

export function dispatchTool(taskExtensions: Extension[], taskModel: ModelRef) {
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
          model: taskModel, extensions: taskExtensions, tools: null, modelTools: null, maxTurns: 40,
          instructions: "Carry out the assigned brief. Request any missing capability. " + reminder,
        });
        (await tx.doc(TaskIdentity, child.id)).taskId = taskId;
        tasks.byId[taskId] = {
          conversationId: child.id, brief: args.brief, permission: args.permission, allow: args.allow, status: "running",
        };
      }, ctx);
      return reply(taskId);
    },
  });
}
