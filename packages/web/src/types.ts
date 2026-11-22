// Mirrors docs/architecture/web-api.md (v1).

export type TimelineItem = {
  id: string;
  kind: "user" | "assistant" | "report" | "permission" | "notice";
  text: string;
  at: number;
  taskId?: string;
  model?: string;
};

export type PermissionRequest = {
  id: string;
  taskId: string;
  audience: "main" | "user";
  capability: string;
  tool: string;
  arguments: unknown;
  reason: string;
};

export type Task = {
  taskId: string;
  brief: string;
  context: "fork" | "fresh";
  permission: "restricted" | "auto" | "full";
  allow: string[];
  status: "running" | "completed" | "failed";
  failure?: string;
  conversationId: string;
  createdAt: number;
  pending: PermissionRequest[];
};

export type LedgerEntry = { taskId: string; summary: string; refs: { kind: string; ref: string }[]; at: number };

export type Lease = { capability: string; idleTurns: number; window: number };

export type TranscriptItem =
  | { kind: "user" | "assistant"; text: string; at: number }
  | { kind: "tool_call"; tool: string; arguments: unknown; at: number }
  | { kind: "tool_result"; tool: string; text: string; isError: boolean; at: number };

export type Snapshot = {
  timeline: TimelineItem[];
  tasks: Task[];
  pending: PermissionRequest[];
  ledger: LedgerEntry[];
  leases: Lease[];
  busy: boolean;
};

export type UsageRow = {
  model: string;
  calls: number;
  failureRate: string;
  aborted?: number;
  fallbacks: number;
  inputTokens: number;
  outputTokens: number;
  p50Ms: number;
  p95Ms: number;
};
