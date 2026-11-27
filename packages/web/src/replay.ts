// A deterministic, synthetic session. Frames use the same reducer actions as live SSE.
import { initialState, reduce, type Action } from "./store.ts";
import type { PermissionRequest, Task, ToolTrace } from "./types.ts";

export const replayStart = Date.UTC(2026, 10, 22, 2);
const taskId = "task-042";
const task: Task = {
  taskId, brief: "整理会议笔记并发送摘要", context: "fresh", permission: "restricted",
  allow: [], conversationId: "session-042", createdAt: replayStart + 1000, status: "queued", pending: [],
};
const request: PermissionRequest = {
  id: "approval-042", taskId, audience: "user", capability: "mail", tool: "mail_send", effect: "write",
  arguments: { to: "team@example.invalid", subject: "会议摘要", text: "本周完成回放与审批联调。" },
  reason: task.brief, expiresAt: replayStart + 600_000,
};
type Frame = { at: number; actions: Action[] };
export type ReplayChoice = "once" | "deny";

export function replayFrames(choice: ReplayChoice): Frame[] {
  const allowed = choice === "once";
  const trace = (id: number, offset: number, tool: string, effect: ToolTrace["effect"], decision: ToolTrace["decision"]): ToolTrace =>
    ({ id, at: replayStart + offset, taskId, tool, effect, decision });
  const read = trace(1, 2400, "notes_read", "read", "allow");
  const draft = trace(2, 4800, "notes_update", "write", "allow");
  const park = trace(3, 6000, "mail_send", "write", "park");
  const answer = trace(4, 9500, "mail_send", "write", allowed ? "allow" : "deny");
  const running = { ...task, status: "running" as const };
  const summary = allowed ? "已发送会议摘要" : "已保留草稿，用户拒绝发送";
  return [
    { at: replayStart, actions: [{ type: "busy", busy: true }, { type: "timeline", item:
      { id: "brief", at: replayStart, kind: "user", text: "整理会议摘要，发出前让我确认。" } }] },
    { at: task.createdAt, actions: [{ type: "tasks", tasks: [task] }, { type: "timeline", item:
      { id: "dispatch", at: task.createdAt, kind: "tool", tool: "dispatch_task", taskId, text: task.brief } }] },
    { at: read.at, actions: [{ type: "tasks", tasks: [running] }, { type: "busy", busy: false }, { type: "traces", traces: [read] }] },
    { at: draft.at, actions: [{ type: "traces", traces: [read, draft] }] },
    { at: park.at, actions: [{ type: "pending", pending: [request] }, { type: "tasks", tasks: [{ ...running, pending: [request] }] },
      { type: "traces", traces: [read, draft, park] }] },
    { at: answer.at, actions: [{ type: "pending", pending: [] }, { type: "tasks", tasks: [running] },
      { type: "traces", traces: [read, draft, park, answer] }] },
    { at: replayStart + 12000, actions: [{ type: "tasks", tasks: [{ ...running, endedAt: replayStart + 12000, status: "completed" }] },
      { type: "ledger", ledger: [{ taskId, at: replayStart + 12000, summary, refs: [] }] },
      { type: "timeline", item: { id: "report", kind: "report", taskId, at: replayStart + 12000, text: summary } }] },
  ];
}

export function replayAt(frames: Frame[], cursor: number) {
  return frames.slice(0, cursor + 1).reduce((state, frame) => frame.actions.reduce(reduce, state), initialState);
}

// Keep a bounded, in-memory history of frames received by this workspace. A reconnect
// snapshot starts a new segment because events during the disconnect may be missing.
export type RecordedFrame = { at: number; event: Action["type"]; state: typeof initialState };
export type Workspace = { state: typeof initialState; history: RecordedFrame[] };
export const initialWorkspace: Workspace = { state: initialState, history: [] };
const recorded = new Set<Action["type"]>(["snapshot", "tasks", "pending", "traces", "timeline", "busy", "delta", "ledger"]);
export const historyLimit = 200;

export function reduceWorkspace(workspace: Workspace, { action, at }: { action: Action; at: number }): Workspace {
  const state = reduce(workspace.state, action);
  if (state === workspace.state) return workspace;
  let history = workspace.history;
  if (action.type === "snapshot") history = [];
  else if (!history.length || !recorded.has(action.type)) return { state, history };
  const previous = history.at(-1);
  const time = Math.max(at, previous?.at ?? at);
  // Cumulative token deltas can arrive many times in a single animation frame.
  const coalesce = action.type === "delta" && previous?.event === "delta" &&
    previous.state.draft?.id === action.id && time - previous.at < 250;
  const kept = coalesce ? history.slice(0, -1) : history.slice(1 - historyLimit);
  const frame = { ...initialState, timeline: state.timeline.slice(-1), tasks: state.tasks, pending: state.pending,
    traces: state.traces, busy: state.busy, draft: state.draft };
  return { state, history: [...kept, { at: coalesce ? previous.at : time, event: action.type, state: frame }] };
}
