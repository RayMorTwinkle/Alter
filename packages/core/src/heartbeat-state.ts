import { FeedbackOutcomes } from "./feedback-settings.ts";
import { contentText } from "@earendil-works/pi-ai";
import { defineDocFamily } from "@earendil-works/pi-durable";
import { conversationDoc, LiveDoc, ROOT_CONVERSATION_ID, type Cursor, type Tx } from "./runtime.ts";

export const hour = 3_600_000;
export const heartbeatKind = "alter.heartbeat";
const alpha = 0.3;
type State = {
  adoptionRate: number; inspections: number; userMessages: number[];
  chat?: { id: string; text: string }[]; lastRunId?: string;
  initialized?: true; lastActivity?: number; lastInspection?: number; exploring?: true; fingerprint?: string; deferredFrom?: number;
  history: { at: number; intervalMs: number }[];
};
export const Heartbeat = conversationDoc<State>("heartbeat", () => ({
  adoptionRate: 0.5, inspections: 0, userMessages: [], history: [],
}));
type Sample = { index: number; implicit?: true; votes: Record<string, boolean> };
const Samples = defineDocFamily<Sample, null>({ kind: "alter.heartbeat-adoption", version: 1,
  family: true, scope: "session", initial: () => ({ index: 0, votes: {} }), checkpointWhen: () => false });

export async function restoreActivity(tx: Tx, at: number) {
  const state = await tx.doc(Heartbeat, ROOT_CONVERSATION_ID);
  const restoreTimes = !state.initialized;
  if (!restoreTimes && state.chat) return;
  state.chat ??= [];
  state.initialized = true;
  let lastWake: number | undefined;
  let needTimes = restoreTimes;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100, cursor);
    for (const entry of page.items) {
      const data = entry.data;
      const meta = data && typeof data === "object" && !Array.isArray(data) ? data : undefined;
      const userInput = (entry.kind === "alter.user-input" || entry.kind === "alter.cli-input") &&
        (typeof meta?.source !== "string" || ["web", "feishu", "cli"].includes(meta.source));
      for (const msg of entry.model ?? []) {
        if (needTimes && (msg.role === "assistant" || msg.role === "user")) state.lastActivity ??= Math.min(at, msg.timestamp);
        if (msg.role !== "user") continue;
        if (needTimes) {
          lastWake ??= msg.timestamp;
          needTimes = msg.timestamp > at - 24 * hour;
          if (needTimes && userInput) state.userMessages.push(msg.timestamp);
        }
        if (userInput && state.chat.length < 8) {
          const text = typeof meta?.text === "string" ? meta.text : contentText(msg.content);
          state.chat.push({ id: String(meta?.id ?? entry.id), text: text.slice(0, 200) });
        }
      }
      if (!needTimes && state.chat.length >= 8) return lastWake;
    }
    cursor = page.next;
  } while (cursor);
  return lastWake;
}

export async function beginInspection(tx: Tx, state: State, at: number, id: string) {
  (await tx.doc(FeedbackOutcomes, ROOT_CONVERSATION_ID)).inspections[id] = { at, value: 0 };
  state.lastRunId = id;
  state.lastInspection = at;
  state.inspections++;
  state.adoptionRate *= 1 - alpha;
  (await tx.doc(Samples, id, null)).index = state.inspections;
}
function adopted(sample: Sample) {
  const votes = Object.values(sample.votes);
  return Number(!votes.includes(false) && (sample.implicit || votes.includes(true)));
}
export async function recordAdoption(tx: Tx, inspection: string | number, vote?: { id: string; useful: boolean }) {
  const state = await tx.doc(Heartbeat, ROOT_CONVERSATION_ID);
  const sample = await tx.doc(Samples, String(inspection), null);
  if (!sample.index) return;
  const previous = adopted(sample);
  if (vote) sample.votes[vote.id] = vote.useful;
  else sample.implicit = true;
  // Late or corrected feedback changes only this inspection's weighted contribution.
  const weight = alpha * (1 - alpha) ** (state.inspections - sample.index);
  const value = adopted(sample);
  state.adoptionRate += weight * (value - previous);
  const outcome = (await tx.doc(FeedbackOutcomes, ROOT_CONVERSATION_ID)).inspections[String(inspection)];
  if (outcome) outcome.value = value;
}
export async function userActivity(tx: Tx, state: State, at: number) {
  state.userMessages = state.userMessages.filter(t => t > at - 24 * hour);
  state.userMessages.push(at);
  const last = state.lastInspection;
  if (last !== undefined && at >= last && at <= last + 2 * hour) await recordAdoption(tx, state.lastRunId ?? last);
}
export async function activeHeartbeat(tx: Tx) {
  const first = (await tx.doc(LiveDoc, ROOT_CONVERSATION_ID)).run?.first;
  const entry = first === undefined ? undefined : await tx.entry(first);
  const data = entry?.data;
  if (entry?.kind === heartbeatKind && data && typeof data === "object" && !Array.isArray(data) && typeof data.at === "number") {
    return { heartbeatAt: data.at, ...(typeof data.id === "string" && { heartbeatId: data.id }) };
  }
}

export async function heartbeatResponse(tx: Tx, id: string) {
  const sample = await tx.doc(Samples, id, null);
  return !!sample.implicit || Object.keys(sample.votes).length > 0;
}
export async function heartbeatAdopted(tx: Tx, id: string) {
  return adopted(await tx.doc(Samples, id, null));
}
