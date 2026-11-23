import { normalizeEffect, type CapabilityRegistry, type Effect } from "./capabilities.ts";
import { conversationDoc } from "./runtime.ts";

export const leaseWindow = 30;
export const Leases = conversationDoc<{
  turns: number; lastUsed: Record<string, number>; records?: Record<string, string>;
}>("leases", () => ({ turns: 0, lastUsed: {} }));

export type LeaseRecord = {
  capability: string; tools: string[]; reason: string; at: number; wakeId?: string;
  approved: boolean; useWakeIds: string[]; calls: number; succeeded: number; failed: number; dispatched: boolean;
};
export const LeaseHistory = conversationDoc<{
  byId: Record<string, LeaseRecord>; inFlight: Record<string, string>;
}>("lease-history", () => ({ byId: {}, inFlight: {} }));

export function leaseTarget(registry: CapabilityRegistry, capability: unknown, action?: unknown) {
  const cap = registry.manifests.find(item => item.id === capability);
  if (!cap || cap.id === "memory" || cap.id === "schedule") return;
  const actions = cap.actions.filter(item => action === undefined || item.name === action);
  if (!actions.length) return;
  const effects: Effect[] = ["irreversible", "write", "read"];
  return { key: action === undefined ? cap.id : cap.id + "/" + action, capability: cap.id,
    tools: actions.map(item => cap.id + "_" + item.name),
    effect: effects.find(effect => actions.some(item => normalizeEffect(item.effect) === effect))! };
}

export function activeLease(lastUsed: Record<string, number>, capability: string, action: string) {
  const key = capability + "/" + action;
  if (Object.hasOwn(lastUsed, key)) return key;
  if (Object.hasOwn(lastUsed, capability)) return capability;
}

export function leaseStats(records: Record<string, LeaseRecord>, includes: (at: number) => boolean) {
  const items = Object.entries(records).filter(([, item]) => includes(item.at))
    .map(([id, item]) => ({ id, ...item })).sort((a, b) => b.at - a.at);
  const byTool = new Map<string, number>();
  for (const item of items) for (const tool of item.tools) byTool.set(tool, (byTool.get(tool) ?? 0) + 1);
  const count = items.length;
  return { count, byTool: Object.fromEntries(byTool), items,
    dispatchAfterLeaseRate: count ? items.filter(item => item.dispatched).length / count : null };
}
