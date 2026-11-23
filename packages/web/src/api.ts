import type { Action } from "./store.ts";
import type { Agenda, ApprovalDecision, FeishuPairing, Funnel, HeartbeatView, MemoryItem, Snapshot, Stats, StatsRange, TranscriptItem, UsageRow } from "./types.ts";

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
  heartbeat: () => request<HeartbeatView>("/api/heartbeat"),
  runHeartbeat: () => request<unknown>("/api/heartbeat/run", { body: {} }),
  heartbeatFeedback: (id: string, feedback: "useful" | "useless") =>
    request<void>(`/api/heartbeat/${encodeURIComponent(id)}/feedback`, { body: { feedback } }),
  stats: (range: StatsRange) => request<Stats>(`/api/stats?range=${range}`),
  calendar: () => request<Agenda>("/api/calendar"),
  feishu: () => request<FeishuPairing>("/api/feishu"),
  disconnectFeishu: () => request<void>("/api/feishu/account/disconnect", { method: "POST", body: {} }),
  memory: () => request<MemoryItem[]>("/api/memory"),
  funnel: (days = 7) => request<Funnel>(`/api/funnel?days=${days}`),
  updateNotification: (id: string, patch: { status?: "read"; feedback?: "useful" | "useless" }) =>
    request<void>(`/api/notifications/${encodeURIComponent(id)}`, { body: patch }),
  updateMemory: (id: string, patch: Partial<Pick<MemoryItem, "text" | "status">>) =>
    request<void>(`/api/memory/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  deleteMemory: (id: string) => request<void>(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

const events = ["snapshot", "timeline", "delta", "tasks", "pending", "ledger", "busy", "calendar", "memory", "notifications", "heartbeat", "schedules", "watches"] as const;

// EventSource retries on its own; on error we probe once so an expired session drops to the login screen.
export function connect(dispatch: (action: Action) => void, onUnauthorized: () => void) {
  const source = new EventSource("/api/events");
  source.onopen = () => {
    dispatch({ type: "connection", connection: "open" });
    // Changes made while disconnected are not replayed; a 404 means this server has no calendar.
    api.calendar().then(agenda => dispatch({ type: "agenda", agenda }), () => {});
    api.memory().then(memory => dispatch({ type: "memory", memory }), () => {});
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
      }
    });
  }
  return () => source.close();
}
