import { day, lastInteraction, type FeedbackQuestion } from "./feedback.ts";
import { conversationDoc, LiveDoc, ROOT_CONVERSATION_ID as root, type Tx } from "./runtime.ts";

export type ReportView = { intervalDays: number; activeDays: number; time: string; nextAt: number | null; paused: boolean };
export const Reports = conversationDoc<{
  started?: number; lastUser?: number; days: number[]; lastCheck?: number; ledgerCursor: number; digestCursor?: number; view?: ReportView;
  pending?: { id: string; ledgerEnd: number; digestEnd: number; questions: FeedbackQuestion[] };
}>("reports", () => ({ days: [], ledgerCursor: 0 }));

export async function inactive(tx: Tx, at: number) {
  const state = await tx.doc(Reports, root);
  const latest = Math.max(await lastInteraction(tx), state.lastUser ?? -Infinity);
  return at - (Number.isFinite(latest) ? latest : state.started ?? at) >= 7 * day;
}

export async function acknowledgeReport(tx: Tx) {
  const state = await tx.doc(Reports, root);
  const pending = state.pending;
  if (!pending) return;
  const submission = await tx.submissionByRequest(root, pending.id);
  if (!submission || !(await tx.doc(LiveDoc, root)).run?.inputs.includes(submission.id)) return;
  state.ledgerCursor = pending.ledgerEnd;
  state.digestCursor = pending.digestEnd;
  delete state.pending;
  const questions = pending.questions.map((q, index) =>
    [`${index + 1}. ${q.prompt}`, ...q.options.map(option => `   - ${option}`)].join("\n"));
  return questions.length ? [...questions, "可在 Web「回访与反馈」或直接回复作答。"].join("\n\n") : "";
}
