import { conversationDoc, ROOT_CONVERSATION_ID, type Cursor, type EntryRecord, type Tx } from "./runtime.ts";
import type { ExternalEvent } from "./capabilities.ts";

export type OwnMessage = { id: string; text: string; at: number };
type Inbox = {
  initialized?: true; turns: number; messages: OwnMessage[]; lastUserAt?: number; through?: number;
};
export const MemoryInbox = conversationDoc<Inbox>("memory-inbox", () => ({ turns: 0, messages: [] }));

export async function recordUserMessage(tx: Tx, message: OwnMessage) {
  const state = await tx.doc(MemoryInbox, ROOT_CONVERSATION_ID);
  state.turns++;
  state.lastUserAt = Math.max(state.lastUserAt ?? message.at, message.at);
  state.messages.push(message);
}

export async function recordOwnEvent(tx: Tx, event: ExternalEvent) {
  if (event.author !== "user" || !event.text?.trim()) return;
  const state = await tx.doc(MemoryInbox, ROOT_CONVERSATION_ID);
  const id = event.source + "/" + event.ref;
  if (state.messages.some(m => m.id === id) || (state.through !== undefined && event.at <= state.through)) return;
  state.messages.push({ id, text: event.text, at: event.at });
  state.lastUserAt = Math.max(state.lastUserAt ?? 0, event.at);
}

export function ownUserMessage(entry: EntryRecord): OwnMessage | undefined {
  const d = entry.data;
  if (entry.kind !== "alter.user-input" || !d || typeof d !== "object" || Array.isArray(d)) return;
  if (typeof d.source !== "string" || !["web", "cli", "feishu"].includes(d.source) ||
    typeof d.id !== "string" || typeof d.text !== "string" || typeof d.at !== "number") return;
  return { id: d.id, at: d.at, text: d.text };
}

export async function restoreMemoryInbox(tx: Tx) {
  const state = await tx.doc(MemoryInbox, ROOT_CONVERSATION_ID);
  if (state.initialized) return;
  const pending = new Set(state.messages.map(m => m.id));
  const prior: OwnMessage[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 200, cursor);
    for (const entry of page.items) {
      const message = ownUserMessage(entry);
      if (message && !pending.has(message.id)) prior.push(message);
    }
    cursor = page.next;
  } while (cursor);
  if (prior.length) {
    state.turns += prior.length;
    state.messages = [...prior, ...state.messages];
    state.lastUserAt = Math.max(state.lastUserAt ?? 0, prior.at(-1)!.at);
  }
  state.initialized = true;
}

export type ConsolidatedBatch = { first: string; last: string; count: number; turns: number; through: number };
export function consumeBatch(state: Inbox, batch: ConsolidatedBatch) {
  if (state.messages[0]?.id !== batch.first || state.messages[batch.count - 1]?.id !== batch.last) return;
  state.messages.splice(0, batch.count);
  state.turns -= batch.turns;
  state.through = batch.through;
}
