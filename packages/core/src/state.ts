import { conversationDoc, type ConversationId, type EntryId, type ModelThinkingLevel, type TaskId } from "./runtime.ts";

export type Permission = "restricted" | "auto" | "full";
export type TaskRecord = {
  conversationId: ConversationId;
  brief: string;
  worker: TaskId;
  lastEntry?: EntryId;
  continuedFrom?: string;
  thinking: ModelThinkingLevel;
  messages?: { at: number; text: string }[];
  context: "fork" | "fresh";
  createdAt: number;
  endedAt?: number;
  wakeId?: string;
  permission: Permission;
  status: "running" | "completed" | "failed" | "cancelled";
  failure?: string;
  proactive?: true;
  heartbeatAt?: number; heartbeatId?: string;
  goal?: { text: string; timeZone: string };
};

export const Tasks = conversationDoc<{ byId: Record<string, TaskRecord> }>("tasks", () => ({ byId: {} }));
export const TaskIdentity = conversationDoc<{ taskId: string; reminders: number; wakeId?: string }>(
  "task-identity", () => ({ taskId: "", reminders: 0 }),
);
export type LedgerEntry = { taskId: string; summary: string; refs: { kind: string; ref: string }[]; at: number };
export const Ledger = conversationDoc<{ entries: LedgerEntry[] }>("ledger", () => ({ entries: [] }));

export type PermissionItem = { tool: string; target: string; purpose: string };
type Scope = { items: PermissionItem[]; shown?: number; approved?: number; full?: true;
  late: { tool: string; argumentsJson: string }[]; declarations: string[] };
export const ScopeDoc = conversationDoc<Scope>("permission-scope", () => ({ items: [], late: [], declarations: [] }));
