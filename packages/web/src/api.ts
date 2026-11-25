import type { DebugPrompt, DebugSchedule, DebugTrace, DebugTracePage, DebugTraceQuery } from "./types.ts";
import type { Action } from "./store.ts";
import type { AdapterCreate, AdapterPatch, AdapterView, Agenda, AlwaysAllowedCapabilities, ApprovalDecision, ApprovalStats, ExtPluginView, FeedbackAnswer, FeedbackQuestion, FeedbackStats, FeedbackView, FeishuGuide, FeishuPairing, Funnel, HeartbeatView, ModelCapabilities, ModelOverrides, MemoryChange, MemoryPatch, MemoryView, PluginPatch, PluginView, ServiceFlag, ServiceState, Settings, SettingsPatch, Snapshot, SourceCreate, SourceCreateResult, SourcePatch, SourcePreview, SourcePreviewResult, SourceTemplate, SourceView, Stats, StatsRange, TranscriptItem, UsageRow } from "./types.ts";

export class Unauthorized extends Error {}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
    headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  if (response.status === 401) throw new Unauthorized();
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error ?? response.statusText);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  debugTraces: (query: DebugTraceQuery = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    return request<DebugTracePage>(`/api/debug/traces?${params}`);
  },
  debugTrace: (id: number) => request<DebugTrace>(`/api/debug/traces/${id}`),
  debugPrompt: (hash: string) => request<DebugPrompt>(`/api/debug/prompts/${encodeURIComponent(hash)}`),
  debugSchedule: () => request<DebugSchedule>("/api/debug/schedule"),
  login: (password: string) => request<void>("/api/login", { body: { password } }),
  logout: () => request<void>("/api/logout", { method: "POST", body: {} }),
  state: () => request<Snapshot>("/api/state"),
  send: (text: string) => request<{ id: string }>("/api/messages", { body: { text } }),
  answer: (id: string, decision: ApprovalDecision, note?: string) =>
    request<void>(`/api/permissions/${encodeURIComponent(id)}`, { body: note ? { decision, note } : { decision } }),
  stop: () => request<void>("/api/stop", { method: "POST", body: {} }),
  transcript: (taskId: string) =>
    request<{ items: TranscriptItem[] }>(`/api/tasks/${encodeURIComponent(taskId)}/transcript`),
  usage: () => request<UsageRow[]>("/api/usage"),
  cancelWatch: (id: string) => request<void>(`/api/watches/${encodeURIComponent(id)}`, { method: "DELETE" }),
  pauseSchedule: (id: string, paused: boolean) => request<void>(`/api/schedules/${encodeURIComponent(id)}`, { method: "PATCH", body: { paused } }),
  deleteSchedule: (id: string) => request<void>(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }),
  adapters: () => request<AdapterView[]>("/api/adapters"),
  createAdapter: (input: AdapterCreate) => request<AdapterView>("/api/adapters", { body: input }),
  updateAdapter: (id: string, patch: AdapterPatch) => request<AdapterView>(`/api/adapters/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  refreshAdapter: (id: string) => request<AdapterView>(`/api/adapters/${encodeURIComponent(id)}/refresh`, { body: {} }),
  deleteAdapter: (id: string) => request<void>(`/api/adapters/${encodeURIComponent(id)}`, { method: "DELETE", body: {} }),
  plugins: () => request<PluginView[]>("/api/plugins"),
  updatePlugin: (id: string, patch: PluginPatch) => request<PluginView>(`/api/plugins/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  checkPlugin: (id: string) => request<PluginView>(`/api/plugins/${encodeURIComponent(id)}/check`, { body: {} }),
  feishuGuide: () => request<FeishuGuide>("/api/plugins/feishu/guide"),
  sources: () => request<SourceView[]>("/api/sources"),
  sourceTemplates: () => request<SourceTemplate[]>("/api/sources/templates"),
  previewSource: (spec: SourcePreview) => request<SourcePreviewResult>("/api/sources/preview", { body: spec }),
  createSource: (spec: SourceCreate) => request<SourceCreateResult>("/api/sources", { body: spec }),
  updateSource: (id: string, patch: SourcePatch) => request<SourceView>(`/api/sources/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  deleteSource: (id: string) => request<void>(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
  feedback: () => request<FeedbackView>("/api/feedback"),
  feedbackStats: () => request<FeedbackStats>("/api/feedback/stats"),
  answerFeedback: (id: string, answer: FeedbackAnswer) => request<void>(`/api/feedback/${encodeURIComponent(id)}/answer`, { body: answer }),
  skipFeedback: (id: string) => request<void>(`/api/feedback/${encodeURIComponent(id)}/skip`, { body: {} }),
  moreFeedback: () => request<FeedbackQuestion[]>("/api/feedback/more", { body: {} }),
  undoFeedbackChange: (id: string) => request<void>(`/api/feedback/changes/${encodeURIComponent(id)}/undo`, { body: {} }),
  extPlugins: () => request<ExtPluginView[]>("/api/ext-plugins"),
  extPluginAction: (id: string, action: "approve" | "reject" | "rollback" | "disable" | "enable", body: Record<string, string> = {}) =>
    request<void>(`/api/ext-plugins/${encodeURIComponent(id)}/${action}`, { body }),
  deleteExtPlugin: (id: string) => request<void>(`/api/ext-plugins/${encodeURIComponent(id)}`, { method: "DELETE" }),
  models: () => request<ModelCapabilities[]>("/api/models"),
  updateModel: (id: string, overrides: ModelOverrides) =>
    request<ModelCapabilities>("/api/models/" + encodeURIComponent(id), { method: "PUT", body: overrides }),
  settings: () => request<Settings>("/api/settings"),
  updateSettings: (patch: SettingsPatch) => request<Settings>("/api/settings", { method: "PATCH", body: patch }),
  service: () => request<ServiceState>("/api/service"),
  alwaysAllowed: () => request<AlwaysAllowedCapabilities>("/api/settings/always-allowed"),
  revokeAlwaysAllowed: (capability: string) =>
    request<AlwaysAllowedCapabilities>("/api/settings/always-allowed/" + encodeURIComponent(capability), { method: "DELETE" }),
  updateService: (patch: Partial<Record<ServiceFlag, boolean>>) => request<ServiceState>("/api/service", { method: "PUT", body: patch }),
  approvalStats: () => request<ApprovalStats>("/api/approvals/stats"),
  heartbeat: () => request<HeartbeatView>("/api/heartbeat"),
  runHeartbeat: () => request<unknown>("/api/heartbeat/run", { body: {} }),
  heartbeatFeedback: (id: string, feedback: "useful" | "useless") =>
    request<void>(`/api/heartbeat/${encodeURIComponent(id)}/feedback`, { body: { feedback } }),
  stats: (range: StatsRange) => request<Stats>(`/api/stats?range=${range}`),
  calendar: () => request<Agenda>("/api/calendar"),
  feishu: () => request<FeishuPairing>("/api/feishu"),
  disconnectFeishu: () => request<void>("/api/feishu/account/disconnect", { method: "POST", body: {} }),
  memory: () => request<MemoryView>("/api/memory?memory=entries"),
  memoryChanges: () => request<MemoryChange[]>("/api/memory/changes"),
  undoMemoryChange: (id: string) => request<void>(`/api/memory/changes/${encodeURIComponent(id)}/undo`, { body: {} }),
  funnel: (days = 7) => request<Funnel>(`/api/funnel?days=${days}`),
  updateNotification: (id: string, patch: { status?: "read"; feedback?: "useful" | "useless" }) =>
    request<void>(`/api/notifications/${encodeURIComponent(id)}`, { body: patch }),
  updateMemory: (id: string, patch: MemoryPatch) =>
    request<void>(`/api/memory/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  deleteMemory: (id: string) => request<void>(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

const events = ["snapshot", "timeline", "delta", "tasks", "pending", "ledger", "busy", "calendar", "memory", "notifications", "heartbeat", "schedules", "watches", "ext-plugins", "feedback"] as const;

// EventSource retries on its own; on error we probe once so an expired session drops to the login screen.
export function connect(dispatch: (action: Action) => void, onUnauthorized: () => void) {
  const source = new EventSource("/api/events?memory=entries");
  source.onopen = () => {
    dispatch({ type: "connection", connection: "open" });
    // Changes made while disconnected are not replayed; a 404 means this server has no calendar.
    api.calendar().then(agenda => dispatch({ type: "agenda", agenda }), () => {});
    api.memory().then(memory => dispatch({ type: "memory", memory }), () => {});
    api.extPlugins().then(extPlugins => dispatch({ type: "extPlugins", extPlugins }), () => {});
    api.feedback().then(feedback => dispatch({ type: "feedback", feedback }), () => {});
  };
  source.onerror = () => {
    dispatch({ type: "connection", connection: "lost" });
    api.state().catch(error => {
      if (error instanceof Unauthorized) {
        source.close();
        onUnauthorized();
      }
    });
  };
  for (const name of events) {
    source.addEventListener(name, event => {
      const data = JSON.parse((event as MessageEvent<string>).data);
      switch (name) {
        case "snapshot": return dispatch({ type: "snapshot", snapshot: data });
        case "timeline": return dispatch({ type: "timeline", item: data });
        case "delta": return dispatch({ type: "delta", id: data.id, text: data.text });
        case "tasks": return dispatch({ type: "tasks", tasks: data });
        case "pending": return dispatch({ type: "pending", pending: data });
        case "ledger": return dispatch({ type: "ledger", ledger: data });
        case "busy": return dispatch({ type: "busy", busy: data.busy });
        case "calendar": return dispatch({ type: "agenda", agenda: data });
        case "memory": return dispatch({ type: "memory", memory: data });
        case "notifications": return dispatch({ type: "notifications", notifications: data });
        case "heartbeat": return dispatch({ type: "heartbeat" });
        case "schedules": return dispatch({ type: "schedules", schedules: data });
        case "watches": return dispatch({ type: "watches", watches: data });
        case "ext-plugins": return dispatch({ type: "extPlugins", extPlugins: data });
        case "feedback": return dispatch({ type: "feedback", feedback: data });
      }
    });
  }
  return () => source.close();
}
