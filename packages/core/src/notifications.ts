import { context, conversationDoc, ROOT_CONVERSATION_ID, type Conversation, type Tx } from "./runtime.ts";

export type Notification = {
  id: string; at: number; kind: "reminder" | "event" | "digest"; level: "now" | "digest" | "silent";
  title: string; body?: string; source: string; ref?: string; filtered?: "duplicate" | "mute" | "marketing";
  status: "unread" | "read"; feedback?: "useful" | "useless"; pushedAt?: number;
};
export const Notifications = conversationDoc<{ entries: Notification[] }>("notifications", () => ({ entries: [] }));

const DigestDay = conversationDoc<{ day?: number; sent?: true; overflow: Notification[] }>("digest-day", () => ({ overflow: [] }));

export async function digestDay(tx: Tx, day: number) {
  const state = await tx.doc(DigestDay, ROOT_CONVERSATION_ID);
  if (state.day !== day) {
    state.day = day;
    state.overflow = [];
    delete state.sent;
  }
  return state;
}

export async function addNotification(tx: Tx, item: Notification, day: number) {
  const { entries } = await tx.doc(Notifications, ROOT_CONVERSATION_ID);
  entries.unshift(item);
  if (entries.length <= 500) return;
  const oldest = entries.pop()!;
  if (oldest.level === "digest" && oldest.status === "unread" && oldest.at >= day) {
    const state = await digestDay(tx, day);
    if (!state.sent) state.overflow.push(oldest);
  }
}

export function updateNotification(main: Conversation, id: string, patch: { status?: "read"; feedback?: Notification["feedback"]; pushedAt?: number }) {
  return main.commit(async tx => {
    const item = (await tx.doc(Notifications, main.id)).entries.find(item => item.id === id)
      ?? (await tx.doc(DigestDay, main.id)).overflow.find(item => item.id === id);
    if (!item) return false;
    if (patch.status) item.status = patch.status;
    if (patch.pushedAt !== undefined) item.pushedAt ??= patch.pushedAt;
    if (patch.feedback) item.feedback = patch.feedback;
    return true;
  }, context);
}
