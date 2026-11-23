// Mirrors docs/architecture/web-api.md (v1.15).

export type TimelineItem = {
  id: string;
  kind: "user" | "assistant" | "report" | "permission" | "notice";
  text: string;
  at: number;
  taskId?: string;
  model?: string;
  source?: string;
};

export type ApprovalDecision = "once" | "statement" | "task-full" | "deny";
export type HeartbeatSettings = { enabled: boolean; start: string; end: string };
export type Settings = { approvalModel: "shadow" | "auto" | "off"; heartbeat: HeartbeatSettings };
export type SettingsPatch = { approvalModel?: Settings["approvalModel"]; heartbeat?: Partial<HeartbeatSettings> };
export type ApprovalStats = { compared: number; agreed: number; agreementRate: number | null; deniedButInScope: number };
export type PermissionItem = { tool: string; target: string; purpose: string; isNew: boolean };

export type PermissionRequest = {
  id: string;
  taskId: string;
  audience: "main" | "user"; // v1.10 emits user. Older snapshots also contain main.
  capability: string;
  tool: string;
  arguments: unknown;
  reason: string;
  expiresAt: number;
  defaultAt?: number;
  deferred?: true;
  statement?: PermissionItem[];
  tainted?: true;
  taint?: { source: string; capability: string; at: number };
};

export type Task = {
  taskId: string;
  brief: string;
  context: "fork" | "fresh";
  heartbeatAt?: number; heartbeatId?: string;
  continuedFrom?: string;
  triggerSource?: "scheduled";
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  permission: "restricted" | "auto" | "full";
  allow: string[]; // v1.10 compatibility field. The server sends [].
  status: "running" | "completed" | "failed";
  failure?: string;
  conversationId: string;
  createdAt: number;
  pending: PermissionRequest[];
};

export type ScheduleTrigger =
  | { kind: "at"; at: string }
  | { kind: "every"; minutes: number }
  | { kind: "daily"; time: string; weekdays?: number[] }
  | { kind: "event"; eventId: string; offsetMinutes: number; anchor: "start" | "end" };

export type ScheduledTask = {
  id: string; brief: string; trigger: ScheduleTrigger; action: "task" | "wake";
  continue_from?: string; thinking?: "low" | "medium" | "high" | "max";
  createdAt: number; nextAt: number | null; paused: boolean;
  lastRun?: { dueAt: number; at: number; missed: boolean; skipped?: string; taskId?: string };
};

export type Notification = {
  id: string; at: number; kind: "reminder" | "event" | "digest" | "goal" | "notify"; level: "now" | "digest" | "silent";
  title: string; body?: string; source: string; ref?: string; filtered?: "duplicate" | "mute" | "marketing";
  status: "unread" | "read"; feedback?: "useful" | "useless"; pushedAt?: number; heartbeatAt?: number; heartbeatId?: string;
};

export type Funnel = {
  timeZone: string;
  days: { date: string; triggered: number; passed: number; pushed: number; read: number;
    useful: number; useless: number; digests: number; reminders: number }[];
  precision: number | null;
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

export type Watch = {
  id: string; brief: string; where: { channel: "feishu" | "mail"; chatId?: string; contact?: string };
  createdAt: number; until: number; keywords: string[]; thinking: NonNullable<Task["thinking"]>;
  status: "running" | "completed" | "cancelled" | "failed"; wakes: number; pollError?: string;
};

export type Snapshot = {
  schedules?: ScheduledTask[]; // Available from v1.13.
  watches?: Watch[]; // Available from v1.14.
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

export type StatsRange = "day" | "7d" | "30d" | "all";

export type StatsUsage = {
  calls: number; input: number; cacheRead: number; cacheWrite: number; output: number; tokens: number;
  cacheHitRate: number | null; costUsd: number | null;
  errors: number; aborted: number; fallbacks: number; retries: number;
};

export type StatsAudit = {
  taskId: string; tool: string; capability: string; action: string;
  effect: "read" | "write-local" | "external-send" | "irreversible" | "unknown";
  decision: "park" | "allow" | "deny"; at: number; tainted?: true;
};

export type StatsReview = {
  requestId: string; taskId?: string; tool?: string; user?: ApprovalDecision; userAt?: number;
  judgment?: { inScope: boolean; reason: string }; judgedAt?: number; judgeAllowedAt?: number;
  timeoutAt?: number; expiredAt?: number; ended?: "deferred" | "expired";
};

export type StatsTask = {
  triggerSource?: "scheduled";
  taskId: string; status: Task["status"] | "cancelled"; createdAt: number; continuedFrom: string | null;
  wakeId: string | null; thinking: string; models: string[]; usage: StatsUsage;
  usageSource: "ledger" | "transcript" | "none"; durationMs: number | null; rounds: number;
  tools: Record<string, number>; approvals: StatsAudit[]; reviews: StatsReview[]; result: string | null;
};

export type StatsWake = {
  wakeId: string; wakeSource: string; wakeAt: number; usage: StatsUsage; dispatchedTasks: number;
};

export type StatsLatency = { samples: number; p50Ms: number | null; p95Ms: number | null };

export type Stats = {
  range: StatsRange; timeZone: string; at: number; total: StatsUsage;
  byRole: (StatsUsage & { role: string })[]; byModel: (StatsUsage & { model: string })[];
  tasks: { count: number; completed: number; terminal: number; successRate: number | null; items: StatsTask[] };
  wakes: { count: number; bySource: Record<string, number>; items: StatsWake[] };
  approvals: {
    decisions: { park: number; allow: number; deny: number };
    pending: Pick<PermissionRequest, "id" | "taskId" | "audience" | "tool" | "expiresAt">[];
    byApprover: { approver: "user" | "judge" | "timeout"; count: number }[];
    userDecisions: Record<ApprovalDecision, number>; judgments: { inScope: number; outOfScope: number };
    timeouts: number; expired: number; shadow: ApprovalStats; shadowAgreementRate: number | null;
  };
  funnel: Funnel; watchWakeAccuracy: number | null; latency: { firstToken: StatsLatency; total: StatsLatency };
  topTasks: { taskId: string; costUsd: number }[];
  daily: { date: string; usage: StatsUsage; tasks: number; succeeded: number; wakes: number }[];
};
export type HeartbeatStats = { lastInspection?: number; adoptionRate: number; history: { at: number; intervalMs: number }[] };

export type HeartbeatReason = "disabled" | "outside-hours" | "busy" | "busy-timeout" | "recent-activity" | "unchanged" | "budget";
export type HeartbeatRun = {
  id: string; at: number; finishedAt: number | null; status: "ran" | "skipped" | "deferred"; skipReason: HeartbeatReason | null;
  counts: { goals: number; memories: number; chat: number; agenda: number; tasks: number; digests: number };
  actions: { tool: string; id?: string; level?: "now" | "digest" }[];
  notified: boolean; finalReply: string; tokens: number; feedback: "useful" | "useless" | null;
};
type HeartbeatRunEvent = { type: "start" | "end"; id: string } | { type: "feedback"; id: string; feedback: "useful" | "useless" };
export type HeartbeatEvent = HeartbeatRunEvent | { type: "schedule"; nextAt: number | null };
export type HeartbeatView = {
  enabled: boolean; nextAt: number | null; intervalMs: number; adoption: number;
  signals: { dueGoals: number; backlog: number; userMessages24h: number };
  runs: HeartbeatRun[];
};

export type PluginField = {
  key: string; label: string; type: "text" | "secret" | "toggle" | "select";
  required: boolean; help: string; options?: string[]; default?: string | boolean;
};
export type PluginDescription = {
  id: string; name: string; provides: { channels: string[]; capabilities: string[]; sources: string[] }; settings: PluginField[];
};
export type PluginCheck = { id: string; label: string; ok: boolean; detail?: string };
export type PluginStatus = { state: "off" | "needs-config" | "connecting" | "ok" | "error"; detail?: string; checks?: PluginCheck[] };
export type PluginView = PluginDescription & {
  enabled: boolean; values: Record<string, string | boolean | null | { set: boolean }>; status: PluginStatus;
};
export type PluginPatch = { enabled?: boolean; settings?: Record<string, string | boolean | null> };
export type FeishuGuide = { permissionsJson: string; redirectUri: string; eventsMode: "long-connection"; steps: string[] };
