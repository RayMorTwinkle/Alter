// Keep the experimental runtime's imports and shared document conventions here.
import { defineDoc, type JsonObject } from "@earendil-works/pi-durable";

export {
  configure, createRegistry, defineExtension, defineSignal, defineTask, defineTool,
  GenerationTask, Harness, hook, hookTask, LiveDoc, MemoryStorage, ROOT_CONVERSATION_ID,
  SubmissionSettled, ToolTask,
  type Conversation, type ConversationId, type Extension, type HarnessOptions, type ModelRef,
  type Storage, type TaskId, type ToolRegistration, type Tx, type YieldDecision,
} from "@earendil-works/pi-durable";
export { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
export { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

export function conversationDoc<T extends JsonObject>(name: string, initial: () => T) {
  return defineDoc<T>({
    kind: `alter.${name}`, initial, version: 1, scope: "conversation",
    history: "latest", fork: "initial", checkpointWhen: () => false,
  });
}

export function reply(text: string, isError = false) {
  return { output: [{ type: "text" as const, text }], isError };
}
