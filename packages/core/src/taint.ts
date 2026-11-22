import { conversationDoc, type ConversationId, type Tx } from "./runtime.ts";

export type TaintSource = { source: string; capability: string; at: number };
export const Taint = conversationDoc<{ first?: TaintSource }>("taint", () => ({}));

export async function inheritTaint(tx: Tx, from: ConversationId, to: ConversationId) {
  const { first } = await tx.doc(Taint, from);
  if (first) (await tx.doc(Taint, to)).first ??= { ...first };
}

export function isUntrusted(details: unknown) {
  return typeof details === "object" && details !== null && "untrusted" in details && details.untrusted === true;
}
