// Mirrors docs/architecture/web-api.md (v1.23).

export type TimelineItem = {
  id: string;
  kind: "user" | "assistant" | "thinking" | "tool" | "message" | "report" | "permission" | "notice";
  text: string;
  at: number;
  tool?: string;
  args?: string;
  isError?: boolean;
  taskId?: string;
  model?: string;
  source?: string;
};

export type AlwaysAllowedCapabilities = { capabilities: string[] };
export type ApprovalDecision = "once" | "capability" | "always" | "deny";
export type HeartbeatSettings = { enabled: boolean; start: string; end: string };
export type ModelOverrides = {
  contextWindow?: number; maxTokens?: number; input?: ("text" | "image")[]; reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
};
export type ModelCapabilities = Omit<Required<ModelOverrides>, "thinkingLevelMap"> & {
  id: string; thinkingLevelMap: NonNullable<ModelOverrides["thinkingLevelMap"]> | null;
  sources: Record<keyof ModelOverrides, "catalog" | "manual" | "default">;
};
export type ServiceState = { supported: boolean; autostart: boolean; keepAlive: boolean; preventSleep: boolean; managed: boolean; failedNode?: string };
export type ServiceFlag = "autostart" | "keepAlive" | "preventSleep";
export type Settings = { compactAtTokens: number; approvalModel: "on" | "off"; heartbeat: HeartbeatSettings };
export type SettingsPatch = { compactAtTokens?: number; approvalModel?: Settings["approvalModel"]; heartbeat?: Partial<HeartbeatSettings> };
export type ApprovalStats = { modelAllowed: number; askedUser: number; userApproved: number; userDenied: number };
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
  // v1.13 snapshots only have action. v1.21 returns both fields.
  id: string; brief: string; trigger: ScheduleTrigger; type?: "reminder" | "task" | "wake"; action: "reminder" | "task" | "wake";
  continue_from?: string; thinking?: "low" | "medium" | "high" | "max";
  createdAt: number; nextAt: number | null; paused: boolean;
  lastRun?: { dueAt: number; at: number; missed: boolean; skipped?: string; taskId?: string };
};

export type Notification = {
  category?: string; // v1.20 external event kind.
  id: string; at: number; kind: "reminder" | "event" | "digest" | "goal" | "notify" | "message"; channel?: "web"; level: "now" | "digest" | "silent";
  title: string; body?: string; source: string; ref?: string; filtered?: "duplicate" | "mute" | "marketing";
  status: "unread" | "read"; feedback?: "useful" | "useless"; pushedAt?: number; heartbeatAt?: number; heartbeatId?: string;
};

export type Funnel = {
  timeZone: string;
  days: { date: string; triggered: number; passed: number; pushed: number; read: number;
    useful: number; useless: number; digests: number; reminders: number }[];
  precision: number | null;
};

export type MemoryEntry = {
  id: string; title: string; type: "user" | "preference" | "goal" | "reference"; body: string; source: string;
  guess: boolean; dueAt?: number; status: "active" | "done" | "pending"; createdAt: number; updatedAt: number; supersededBy?: string;
};
export type MemoryPatch = Partial<Pick<MemoryEntry, "title" | "type" | "body" | "source" | "guess" | "status">> & {
  dueAt?: number | null; text?: string; due?: number | null;
};
export type MemoryView = { index: string; entries: MemoryEntry[]; needsConsolidation: boolean };
export type MemoryChange = {
  id: string; at: number; kind: "write" | "consolidate" | "undo" | "expire"; undoneBy?: string;
  operations: { op: "add" | "modify" | "supersede" | "keep" | "delete" | "restore"; ids: string[] }[];
  snapshots: { id: string; before: MemoryEntry | null; after: MemoryEntry | null }[];
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

export type LedgerEntry = { kind?: "unreplied"; taskId: string; summary: string; refs: { kind: string; ref: string }[]; at: number };

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
  borrower?: string;
  taskId: string; tool: string; capability: string; action: string;
  effect: "read" | "write" | "irreversible";
  decision: "park" | "allow" | "deny"; at: number;
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
  unreplied: number;
  range: StatsRange; timeZone: string; at: number; total: StatsUsage;
  byRole: (StatsUsage & { role: string })[]; byModel: (StatsUsage & { model: string })[];
  leases: {
    count: number; byTool: Record<string, number>; dispatchAfterLeaseRate: number | null;
    items: { id: string; capability: string; tools: string[]; reason: string; at: number; wakeId?: string;
      approved: boolean; useWakeIds: string[]; calls: number; succeeded: number; failed: number; dispatched: boolean }[];
  };
  tasks: { count: number; completed: number; terminal: number; successRate: number | null; items: StatsTask[] };
  wakes: { count: number; bySource: Record<string, number>; items: StatsWake[] };
  approvals: ApprovalStats & {
    decisions: { park: number; allow: number; deny: number };
    pending: Pick<PermissionRequest, "id" | "taskId" | "audience" | "tool" | "expiresAt">[];
    byApprover: { approver: "user" | "judge" | "timeout"; count: number }[];
    userDecisions: Record<ApprovalDecision, number>; judgments: { inScope: number; outOfScope: number };
    timeouts: number; expired: number;
  };
  funnel: Funnel; watchWakeAccuracy: number | null; latency: { firstToken: StatsLatency; total: StatsLatency };
  topTasks: { taskId: string; costUsd: number }[];
  daily: { date: string; usage: StatsUsage; tasks: number; succeeded: number; wakes: number }[];
};
export type HeartbeatStats = { lastInspection?: number; adoptionRate: number; history: { at: number; intervalMs: number }[] };

export type HeartbeatReason = "inactive" | "disabled" | "outside-hours" | "busy" | "busy-timeout" | "recent-activity" | "unchanged" | "budget";
export type HeartbeatRun = {
  id: string; at: number; finishedAt: number | null; status: "ran" | "skipped" | "deferred"; skipReason: HeartbeatReason | null;
  counts: { goals: number; memories: number; chat: number; agenda: number; tasks: number; digests: number };
  actions: { tool: string; id?: string; level?: "now" | "digest" }[];
  notified: boolean; finalReply: string; tokens: number; feedback: "useful" | "useless" | null;
};
type HeartbeatRunEvent = { type: "start" | "end"; id: string } | { type: "feedback"; id: string; feedback: "useful" | "useless" };
export type HeartbeatEvent = HeartbeatRunEvent | { type: "schedule"; nextAt: number | null } | { type: "report"; report: ReportView };
export type ReportView = { intervalDays: number; activeDays: number; time: string; nextAt: number | null; paused: boolean };
export type HeartbeatView = {
  report: ReportView;
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

export type SourceItem = {
  id: string; title: string; url: string; body?: string; publishedAt?: string; repo?: string; type?: string;
};
type SecretSet = { set: boolean };
type SourceSpec<T> = { template: "rss"; params: { url: string } } | { template: "github"; params: { token: T } } |
  { template: "json"; params: { url: string; itemsPath?: string; idField: string; titleField: string; urlField: string;
    bodyField?: string; headers?: Record<string, T>; secrets?: Record<string, T> } };
export type SourceCreate = SourceSpec<string> & { name: string; enabled?: boolean; intervalMinutes?: number };
export type SourcePreview = SourceSpec<string> & Partial<Pick<SourceCreate, "name" | "enabled" | "intervalMinutes">>;
export type SourcePatch = Partial<Pick<SourceCreate, "name" | "enabled" | "intervalMinutes">> & { params?: Partial<SourceCreate["params"]> };
export type SourceView = SourceSpec<SecretSet> & {
  id: string; name: string; enabled: boolean; intervalMinutes: number;
  status: { lastPollAt: number; nextPollAt: number | null; todayCount: number; error: string | null };
};
export type SourceTemplate = { template: SourceCreate["template"]; name: string; fields: PluginField[] };
export type SourcePreviewResult = { samples: SourceItem[] };
export type SourceCreateResult = SourcePreviewResult & { source: SourceView };
export type SourcesEvent = { event: "sources"; data: SourceView[] };

export type ExtPluginEffect = "read" | "write" | "irreversible";
export type ExtPluginSchema = {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string; properties?: Record<string, ExtPluginSchema>; required?: string[]; additionalProperties?: boolean;
  items?: ExtPluginSchema; enum?: (string | number | boolean | null)[];
};
export type ExtPluginTool = {
  name: string; description: string; effect: ExtPluginEffect; inputSchema: ExtPluginSchema; outputSchema?: ExtPluginSchema;
};
export type ExtPluginManifest = {
  schemaVersion: 1; id: string; version: string; displayName: string; description: string;
  tools: ExtPluginTool[];
  sources: { name: string; minIntervalSeconds: number }[];
  requires?: string[];
  network?: { host: string; methods: string[]; pathPrefixes: string[] }[];
  secrets: { name: string; purpose: string }[]; borrows: string[];
  resources: { memoryMB: number; timeoutMs: number; storageKB: number };
};

export type ExtPluginProposal = { manifest: ExtPluginManifest; sha: string; directory: string; codeUrl: string; dependencies: Record<string, string>; permissions: string[]; removed: string[]; expanded: string[]; summary: string };
export type ExtPluginView = {
  id: string; status: "pending" | "enabled" | "disabled" | "paused" | "quarantined"; active: string | null;
  manifest: ExtPluginManifest; failures: number; sources: { name: string; paused: boolean; invalid: number; next: number }[];
  versions: { sha: string; version: string }[]; pending: ExtPluginProposal | null;
};
export type ExtPluginsEvent = { event: "ext-plugins"; data: ExtPluginView[] };

// 反馈闭环（v1.20）
export type FeedbackQuestion = { id: string; prompt: string; options: string[]; allowOther: boolean; multi: boolean; why: string };
export type FeedbackSource = "guess" | "mismatch" | "silent-proactive" | "feature" | "style";
export type FeedbackEffect = { kind: "memory"; entryId: string } | { kind: "metric"; name: string } |
  { kind: "param"; key: "heartbeatBias" | "triagePreference" | "reportFrequency" | "replyLength" | "permissionNotes";
    mapping: Record<string, string | number>; scope?: string };
export type FeedbackAnswer = { options: string[]; other?: string };
export type IssuedFeedback = FeedbackQuestion & {
  candidateId: string; source: FeedbackSource; effect: FeedbackEffect; outlet: "report" | "checkin"; batch: string;
  askedAt: number; status: "pending" | "applying" | "answered" | "skipped" | "expired"; at?: number;
  optionMap?: Record<string, string>; answer?: FeedbackAnswer; moreUsed?: true; changeIds: string[];
};
export type FeedbackValue = string | number | string[] | null;
export type FeedbackChange = { id: string; issueId: string; at: number; kind: "memory" | "param" | "metric" | "undo"; key: string;
  before: FeedbackValue; after: FeedbackValue; memoryChangeId?: string; memoryAction?: "confirm" | "correct" | "delete" | "add" | "modify" | "restore"; undoneBy?: string; undoOf?: string };
export type FeedbackView = { pending: IssuedFeedback[]; history: IssuedFeedback[]; changes: FeedbackChange[] };
export type FeedbackEvent = { event: "feedback"; data: FeedbackView };
export type FeedbackCounts = { asked: number; answered: number; skipped: number; answerRate: number | null; skipRate: number | null };
export type FeedbackWeek = FeedbackCounts & { week: string; changes: number; satisfaction: number | null; usefulness: number | null;
  productFeedback: { feature: string; answer: string[] }[] };
export type FeedbackStats = FeedbackCounts & {
  bySource: Record<FeedbackSource, FeedbackCounts>; byType: Record<"multi" | "single", FeedbackCounts>;
  guesses: { answered: number; confirmed: number; confirmationRate: number | null }; changeCount: number;
  satisfaction: { at: number; value: number }[]; usefulness: { at: number; value: number }[];
  impacts: { changeId: string; metric: string; before: number | null; after: number | null; beforeSamples: number; afterSamples: number }[];
  weekly: FeedbackWeek[];
};

export type { AdapterConfig, AdapterCreate, AdapterEffect, AdapterKind, AdapterPatch, AdapterStatus, AdapterTool, AdapterToolView, AdapterView,
  CliConfig, HttpConfig, McpConfig } from "../../server/src/adapters/types.ts";
