// Keep the experimental runtime's imports and shared document conventions here.
import { dirname, resolve } from "node:path";
import { openNodeSqliteStorage as openSqlite } from "@earendil-works/pi-durable/storage/sqlite/node";
import { defineDoc, type JsonObject, type Storage } from "@earendil-works/pi-durable";
export type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export {
  AgentDoc, configure, createRegistry, defineExtension, defineSignal, defineTask, defineTool,
  GenerationTask, Harness, InboxDoc, hook, hookTask, LiveDoc, MemoryStorage, ProviderDoc, ROOT_CONVERSATION_ID,
  SubmissionSettled, ToolResultEntry, ToolTask,
  type Conversation, type ConversationHandle, type ConversationDocToken, type ConversationId, type Cursor, type EntryId, type EntryRecord, type JsonObject, type LiveState, type InboxState, type Extension, type HarnessOptions, type ModelRef,
  type Storage, type TaskId, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration, type Tx, type YieldDecision,
} from "@earendil-works/pi-durable";
export { BACKGROUND_CONTEXT as context, type Context } from "@earendil-works/chord/context";

// Storage itself exposes no path. Keep sibling databases with the host that opened it.
export const storageDirectories = new WeakMap<Storage, string>();
export async function openNodeSqliteStorage(path: string, options?: Parameters<typeof openSqlite>[1]) {
  const storage = await openSqlite(path, options);
  if (path && path !== ":memory:") storageDirectories.set(storage, dirname(resolve(path)));
  return storage;
}

export function conversationDoc<T extends JsonObject>(name: string, initial: () => T) {
  return defineDoc<T>({
    kind: `alter.${name}`, initial, version: 1, scope: "conversation",
    history: "latest", fork: "initial", checkpointWhen: () => false,
  });
}

export function reply(text: string, isError = false) {
  return { output: [{ type: "text" as const, text }], isError };
}
