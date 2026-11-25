import { day, lastInteraction } from "./feedback.ts";
import { conversationDoc, type EntryId, ROOT_CONVERSATION_ID as root, type Tx } from "./runtime.ts";

export type ReportView = { intervalDays: number; activeDays: number; time: string; nextAt: number | null; paused: boolean };
export const Reports = conversationDoc<{
  started?: number; lastUser?: number; days: number[]; lastCheck?: number; ledgerCursor: number; digestCursor?: number; view?: ReportView;
  pending?: { id: string; ledgerEnd: number; digestEnd: number };
}>("reports", () => ({ days: [], ledgerCursor: 0 }));

export async function inactive(tx: Tx, at: number) {
  const state = await tx.doc(Reports, root);
  const latest = Math.max(await lastInteraction(tx), state.lastUser ?? -Infinity);
  return at - (Number.isFinite(latest) ? latest : state.started ?? at) >= 7 * day;
}

export async function acknowledgeReport(tx: Tx, first: EntryId) {
  const state = await tx.doc(Reports, root);
  const pending = state.pending;
  if (!pending) return;
  const submission = await tx.submissionByRequest(root, pending.id);
  if (submission?.entry !== first) return;
  state.ledgerCursor = pending.ledgerEnd;
  state.digestCursor = pending.digestEnd;
  delete state.pending;
  return true;
}
