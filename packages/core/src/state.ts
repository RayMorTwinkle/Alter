import { conversationDoc, type ConversationId } from "./runtime.ts";

export type Permission = "restricted" | "auto" | "full";
export type TaskRecord = {
  conversationId: ConversationId;
  brief: string;
  context: "fork" | "fresh";
  createdAt: number;
  permission: Permission;
  allow: string[];
  status: "running" | "completed" | "failed";
  failure?: string;
  proactive?: true;
  goal?: { text: string; timeZone: string };
};

export const Tasks = conversationDoc<{ byId: Record<string, TaskRecord> }>("tasks", () => ({ byId: {} }));
export const TaskIdentity = conversationDoc<{ taskId: string; reminders: number }>(
  "task-identity", () => ({ taskId: "", reminders: 0 }),
);
export type LedgerEntry = { taskId: string; summary: string; refs: { kind: string; ref: string }[]; at: number };
export const Ledger = conversationDoc<{ entries: LedgerEntry[] }>("ledger", () => ({ entries: [] }));
