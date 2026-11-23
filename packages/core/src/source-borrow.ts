import { randomUUID } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord/json";
import { NestedCallDoc } from "@earendil-works/pi-durable";
import { configure, context, defineTask, ROOT_CONVERSATION_ID, ToolTask, type Conversation,
  type Extension, type ToolRegistration, type Harness, type JsonObject, type Tx } from "./runtime.ts";
import { TaskIdentity, Tasks } from "./state.ts";
import { Taint } from "./taint.ts";
import { clearRequests } from "./tasks.ts";

type Input = { taskId: string; plugin: string; tool: string; args: JsonObject };
async function finish(tx: Tx, id: string, status: "failed" | "completed" | "cancelled", at: number) {
  const task = (await tx.doc(Tasks, ROOT_CONVERSATION_ID)).byId[id]!;
  task.status = status;
  task.endedAt = at;
  await clearRequests(tx, ROOT_CONVERSATION_ID, id);
}
export const SourceBorrow = defineTask<Input, { phase: "start" | "finish" }, JsonValue>({
  name: "alter.source-borrow", version: 1, initial: () => ({ phase: "start" }),
  phases: {
    start: ({ input }, runtime, ctx) => runtime.commit(async tx => {
      const key = "ext:" + input.plugin + ":read:1";
      const slot = await tx.doc(NestedCallDoc, runtime.taskId, key, null);
      const parentCallId = input.taskId;
      const child = await tx.createTask(ToolTask, {
        kind: "nested", parent: runtime.taskId, parentCallId, key, progress: false,
        call: { id: parentCallId + "/" + key, type: "toolCall", name: input.tool, arguments: input.args },
      }, { ownership: { kind: "task", taskId: runtime.taskId } });
      slot.kind = "nested"; slot.taskId = child;
      return { status: "waiting", on: [child], policy: "allSettled", checkpoint: { phase: "finish" } };
    }, ctx),
    finish: ({ input }, runtime, ctx) => runtime.commit(async tx => {
      const result = (await tx.doc(NestedCallDoc, runtime.taskId, "ext:" + input.plugin + ":read:1", null)).result;
      const failed = !result || result.isError;
      await finish(tx, input.taskId, failed ? "failed" : "completed", runtime.now());
      return { status: "terminal", outcome: failed ? { status: "failed", error: { message: "Borrowed tool failed or was denied" } }
          : { status: "completed", result: result.structuredOutput ?? null } };
    }, ctx),
  },
  abort: ({ input }, runtime, ctx) => runtime.commit(async tx => {
    await finish(tx, input.taskId, "cancelled", runtime.now());
    return { status: "terminal", outcome: { status: "aborted" } };
  }, ctx),
});

export async function borrowForSource(main: Conversation, harness: Harness, extensions: Extension[], plugin: string,
  tool: ToolRegistration, args: JsonObject, signal: AbortSignal, now: number) {
  signal.throwIfAborted();
  const taskId = "feed-" + randomUUID();
  const worker = await main.commit(async tx => {
    const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, child.id, { extensions, tools: [tool], modelTools: [] });
    const worker = await tx.createTask(SourceBorrow, { taskId, plugin, tool: tool.name, args },
      { conversationId: child.id, ownership: { kind: "conversation" }, abandonOnRestart: true });
    const identity = await tx.doc(TaskIdentity, child.id);
    identity.taskId = taskId; identity.sourcePlugin = plugin;
    (await tx.doc(Taint, child.id)).first = { source: "feed:" + plugin, capability: "ext-" + plugin, at: now };
    (await tx.doc(Tasks, main.id)).byId[taskId] = { conversationId: child.id, worker, brief: "插件 " + plugin + " 的消息来源借用 " + tool.name,
      thinking: "off", context: "fresh", permission: "restricted", status: "running", createdAt: now };
    return worker;
  }, context);
  const cancel = () => { void harness.abortTask(worker, context).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    const { outcome } = (await harness.waitForTask(worker, context)).state;
    if (outcome.status !== "completed") throw new Error("Source borrow failed or was denied");
    return outcome.result;
  } finally { signal.removeEventListener("abort", cancel); }
}
