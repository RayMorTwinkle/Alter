import { conversationDoc, ROOT_CONVERSATION_ID, type Tx } from "./runtime.ts";

export type PreferenceKey = "heartbeatBias" | "triagePreference" | "reportFrequency" | "replyLength" | "permissionNotes";
export type PreferenceValue = number | string;
export type FeedbackSettings = {
  heartbeatBias: number; reportFrequency: number; replyLength: string | null;
  triagePreference: Record<string, "now" | "digest" | "silent">; permissionNotes: Record<string, string>;
};
export const triageScope = (source: string, category?: string) => category ? JSON.stringify([source, category]) : source;
export const Preferences = conversationDoc<FeedbackSettings>("feedback-settings", () => ({
  heartbeatBias: 1, reportFrequency: 1, replyLength: null, triagePreference: {}, permissionNotes: {},
}));
export const Interaction = conversationDoc<{ at?: number }>("user-interaction", () => ({}));
export async function interacted(tx: Tx, at: number) {
  const state = await tx.doc(Interaction, ROOT_CONVERSATION_ID);
  state.at = Math.max(state.at ?? at, at);
}

export const FeedbackOutcomes = conversationDoc<{
  inspections: Record<string, { at: number; value: number }>;
  notifications: Record<string, { at: number; value: number; source: string }>;
}>("feedback-outcomes", () => ({ inspections: {}, notifications: {} }));
