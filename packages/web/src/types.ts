// Mirrors docs/architecture/web-api.md (v1.7).

export type TimelineItem = {
  id: string;
  kind: "user" | "assistant" | "report" | "permission" | "notice";
  text: string;
  at: number;
  taskId?: string;
  model?: string;
  source?: string;
};

export type PermissionRequest = {
  id: string;
  taskId: string;
  audience: "main" | "user";
  capability: string;
  tool: string;
  arguments: unknown;
  reason: string;
  expiresAt: number;
  tainted?: true;
  taint?: { source: string; capability: string; at: number };
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

export type Notification = {
  id: string; at: number; kind: "reminder"; level: "now" | "digest" | "silent";
  title: string; body?: string; source: "schedule"; status: "unread" | "read"; feedback?: "useful" | "useless";
};

export type MemoryItem = {
  id: string;
  kind: "profile" | "goal" | "fact";
  text: string;
  due?: number;
  status: "active" | "done" | "pending";
  createdAt: number;
  updatedAt: number;
};

export type LedgerEntry = { taskId: string; summary: string; refs: { kind: string; ref: string }[]; at: number };

export type Lease = { capability: string; idleTurns: number; window: number };

export type TranscriptItem =
  | { kind: "user" | "assistant"; text: string; at: number }
  | { kind: "tool_call"; tool: string; arguments: unknown; at: number }
  | { kind: "tool_result"; tool: string; text: string; isError: boolean; at: number };

export type Snapshot = {
  notifications?: Notification[]; // Absent in v1.6 snapshots and before the first snapshot.
  timeline: TimelineItem[];
  tasks: Task[];
  pending: PermissionRequest[];
  ledger: LedgerEntry[];
  leases: Lease[];
  busy: boolean;
};

export type FeishuPairing = ({ paired: true } | { paired: false; code: string; expiresAt: number })
  & { account: { connected: boolean; name?: string } };

export type AgendaEvent = { id: string; title: string; start: number; end: number; allDay: boolean; location?: string; notes?: string };

export type Agenda = { timeZone: string; events: AgendaEvent[] };

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
