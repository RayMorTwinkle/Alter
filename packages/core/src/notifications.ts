import { defineDocFamily } from "@earendil-works/pi-durable";
import { obj, oneOf, str } from "@earendil-works/pi-schema";
import type { calendarTime } from "./calendar-time.ts";
import { activeHeartbeat, recordAdoption } from "./heartbeat-state.ts";
import { context, defineTool, reply, conversationDoc, ROOT_CONVERSATION_ID, type Conversation, type Tx } from "./runtime.ts";

export type Notification = {
  id: string; at: number; kind: "reminder" | "event" | "digest" | "goal" | "notify"; level: "now" | "digest" | "silent";
  title: string; body?: string; source: string; ref?: string; filtered?: "duplicate" | "mute" | "marketing";
  status: "unread" | "read"; feedback?: "useful" | "useless"; pushedAt?: number; heartbeatAt?: number; heartbeatId?: string;
};
export const Notifications = conversationDoc<{ entries: Notification[] }>("notifications", () => ({ entries: [] }));

const DigestDay = conversationDoc<{ day?: number; sent?: true; overflow: Notification[] }>("digest-day", () => ({ overflow: [] }));

const Claims = defineDocFamily<{ claimed: boolean }, null>({ kind: "alter.notification-claim", version: 1,
  family: true, scope: "session", initial: () => ({ claimed: false }), checkpointWhen: () => false });
export async function claim(tx: Tx, ref: string) {
  (await tx.doc(Claims, ref, null)).claimed = true;
  for (const item of (await tx.doc(Notifications, ROOT_CONVERSATION_ID)).entries) {
    if (item.kind === "event" && item.ref === ref && item.level === "now" && item.pushedAt === undefined &&
      !(await tx.doc(Delivered, item.id, null)).seen) {
      item.level = "silent";
      item.filtered = "duplicate";
    }
  }
}
export async function isClaimed(tx: Tx, ref: string) {
  return (await tx.doc(Claims, ref, null)).claimed;
}

export function dataLine(fields: readonly (string | number)[]) {
  return JSON.stringify(fields).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}
type Buffer = { count: number; lines: string[] };
function append(buffer: Buffer, line: string, limit: number, maxItems = Infinity) {
  buffer.count++;
  buffer.lines.push(line);
  let length = buffer.lines.reduce((n, row) => n + row.length + 1, 0);
  while (buffer.lines.length > maxItems || length > limit) length -= buffer.lines.shift()!.length + 1;
}
const WakeNotifications = conversationDoc<{ pushed: Buffer; digest: Buffer; cursor: number; initialized?: true }>(
  "wake-notifications", () => ({ pushed: { count: 0, lines: [] }, digest: { count: 0, lines: [] }, cursor: 0 }));
function pushed(buffer: Buffer, item: Notification) {
  append(buffer, dataLine([item.id, item.source.slice(0, 48), item.title.slice(0, 140)]), 1420, 20);
}
function digest(buffer: Buffer, item: Notification) {
  append(buffer, dataLine([item.id, item.source.slice(0, 48), item.title.slice(0, 120), (item.body ?? "").slice(0, 160)]), 2400);
}
export async function wakeNotifications(tx: Tx, since = -Infinity) {
  const state = await tx.doc(WakeNotifications, ROOT_CONVERSATION_ID);
  if (!state.initialized) {
    const entries = (await tx.doc(Notifications, ROOT_CONVERSATION_ID)).entries;
    const overflow = (await tx.doc(DigestDay, ROOT_CONVERSATION_ID)).overflow;
    for (const item of [...overflow, ...entries.toReversed()]) if (item.level === "digest") digest(state.digest, item);
    for (const item of entries.filter(n => n.pushedAt !== undefined && n.pushedAt >= since).sort((a, b) => a.pushedAt! - b.pushedAt!)) pushed(state.pushed, item);
    state.initialized = true;
  }
  return state;
}

const Delivered = defineDocFamily<{ seen: boolean }, null>({ kind: "alter.notification-delivery", version: 1,
  family: true, scope: "session", initial: () => ({ seen: false }), checkpointWhen: () => false });

export async function recordDeliveries(tx: Tx, items: readonly Notification[]) {
  const state = await wakeNotifications(tx);
  for (const item of items) {
    const receipt = await tx.doc(Delivered, item.id, null);
    if (!receipt.seen && item.pushedAt === undefined) pushed(state.pushed, item);
    receipt.seen = true;
  }
}

export function notifyTool(time: ReturnType<typeof calendarTime>) {
  return defineTool({ name: "notify", description: "向用户发送立即通知，或记入摘要。安静时段立即通知自动进入摘要。",
    parameters: obj({ level: oneOf(["now", "digest"]), title: str({ pattern: "\\S", maxLength: 200 }),
      body: str({ maxLength: 2000 }) }), replay: "safe",
    execute: ({ level, title, body }, api, ctx) => api.commit(async tx => {
      const id = `notify-${api.taskId}`;
      const at = api.now();
      const inspection = await activeHeartbeat(tx);
      const receipt = await tx.doc(NotifyReceipt, id, null);
      if (!receipt.sent) {
        receipt.level = level === "now" && time.quietHours(at) ? "digest" : level;
        await addNotification(tx, { id, at, kind: "notify", title, body, source: "alter", status: "unread",
          level: receipt.level, ...inspection }, time.midnight(at));
        receipt.sent = true;
      }
      return reply(id);
    }, ctx) });
}
export const NotifyReceipt = defineDocFamily<{ sent: boolean; level?: "now" | "digest" }, null>({ kind: "alter.notify-receipt", version: 1,
  family: true, scope: "session", initial: () => ({ sent: false }), checkpointWhen: () => false });

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
  if (item.level === "digest") digest((await wakeNotifications(tx)).digest, item);
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
    if (patch.pushedAt !== undefined && item.pushedAt === undefined) {
      await recordDeliveries(tx, [item]);
      item.pushedAt = patch.pushedAt;
    }
    if (patch.feedback && item.heartbeatAt !== undefined) {
      await recordAdoption(tx, item.heartbeatId ?? item.heartbeatAt, { id, useful: patch.feedback === "useful" });
    }
    if (patch.feedback) item.feedback = patch.feedback;
    return true;
  }, context);
}
