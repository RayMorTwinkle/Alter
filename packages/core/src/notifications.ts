import { context, conversationDoc, type Conversation } from "./runtime.ts";

export type Notification = {
  id: string; at: number; kind: "reminder"; level: "now" | "digest" | "silent";
  title: string; body?: string; source: "schedule"; status: "unread" | "read"; feedback?: "useful" | "useless";
};
export const Notifications = conversationDoc<{ entries: Notification[] }>("notifications", () => ({ entries: [] }));

export function updateNotification(main: Conversation, id: string, patch: { status?: "read"; feedback?: Notification["feedback"] }) {
  return main.commit(async tx => {
    const item = (await tx.doc(Notifications, main.id)).entries.find(item => item.id === id);
    if (!item) return false;
    if (patch.status) item.status = patch.status;
    if (patch.feedback) item.feedback = patch.feedback;
    return true;
  }, context);
}
