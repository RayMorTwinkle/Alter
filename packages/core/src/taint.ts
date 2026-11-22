import type { CapabilityRegistry } from "./capabilities.ts";
import { conversationDoc, InboxDoc, type ConversationId, type Cursor, type Tx } from "./runtime.ts";
import { Ledger, type TaskRecord } from "./state.ts";

export type TaintSource = { source: string; capability: string; at: number };
export const Taint = conversationDoc<{ first?: TaintSource }>("taint", () => ({}));

export async function inheritTaint(tx: Tx, from: ConversationId, to: ConversationId) {
  const { first } = await tx.doc(Taint, from);
  if (first) (await tx.doc(Taint, to)).first ??= { ...first };
}

export function isUntrusted(details: unknown) {
  return typeof details === "object" && details !== null && "untrusted" in details && details.untrusted === true;
}

// Older databases keep the result marker in pi.tool-result and report admission times in the ledger or entry.
export async function restoreTaint(tx: Tx, main: ConversationId, tasks: Record<string, TaskRecord>, registry: CapabilityRegistry) {
  const reports = new Map((await tx.doc(Ledger, main)).entries.map(row => [row.taskId, row.at]));
  function noteReport(kind: unknown, data: unknown) {
    if (kind === "alter.task-report" && data && typeof data === "object" && "taskId" in data && typeof data.taskId === "string"
        && "at" in data && typeof data.at === "number") reports.set(data.taskId, data.at);
  }
  for (const item of (await tx.doc(InboxDoc, main)).items) noteReport(item.entry?.kind, item.entry?.data);

  async function firstRead(conversationId: ConversationId) {
    let first: TaintSource | undefined;
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanEntries({ conversationId, order: "ascending" }, 200, cursor);
      for (const entry of page.items) {
        if (conversationId === main) noteReport(entry.kind, entry.data);
        for (const msg of entry.model ?? []) {
          if (!first && msg.role === "toolResult" && isUntrusted(msg.details)) {
            first = { source: msg.toolName, capability: registry.toolActions.get(msg.toolName)?.capability ?? "unknown", at: msg.timestamp };
            if (conversationId !== main) return first;
          }
        }
      }
      cursor = page.next;
    } while (cursor);
    return first;
  }

  let source = await firstRead(main);
  let reachedMain = source?.at ?? Infinity;
  for (const [id, task] of Object.entries(tasks)) {
    const first = await firstRead(task.conversationId);
    if (!first) continue;
    (await tx.doc(Taint, task.conversationId)).first = first;
    const at = reports.get(id);
    if (at !== undefined && at < reachedMain) {
      source = first;
      reachedMain = at;
    }
  }
  const root = await tx.doc(Taint, main);
  if (!source) return;
  root.first = source;
  for (const task of Object.values(tasks)) {
    if (task.createdAt >= reachedMain) (await tx.doc(Taint, task.conversationId)).first = { ...source };
  }
}
