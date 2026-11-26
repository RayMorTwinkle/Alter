import type { FeedbackView, ExtPluginView, Agenda, LedgerEntry, MemoryView, Node, Notification, PermissionRequest, ScheduledTask, Snapshot, Watch, Task, TimelineItem } from "./types.ts";

export type State = Snapshot & {
  draft: { id: string; text: string } | null;
  connection: "connecting" | "open" | "lost";
  agenda: Agenda | null; // null until loaded, and when the server has no calendar
  memory: MemoryView | null;
  heartbeatTick: number;
  extPlugins: ExtPluginView[];
  feedback: FeedbackView | null;
  nodes: Node[] | null;
};

export type Action =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "timeline"; item: TimelineItem }
  | { type: "delta"; id: string; text: string }
  | { type: "tasks"; tasks: Task[] }
  | { type: "pending"; pending: PermissionRequest[] }
  | { type: "ledger"; ledger: LedgerEntry[] }
  | { type: "busy"; busy: boolean }
  | { type: "connection"; connection: State["connection"] }
  | { type: "agenda"; agenda: Agenda }
  | { type: "memory"; memory: MemoryView }
  | { type: "notifications"; notifications: Notification[] }
  | { type: "heartbeat" }
  | { type: "schedules"; schedules: ScheduledTask[] }
  | { type: "watches"; watches: Watch[] }
  | { type: "extPlugins"; extPlugins: ExtPluginView[] }
  | { type: "feedback"; feedback: FeedbackView }
  | { type: "nodes"; nodes: Node[] };

export const initialState: State = {
  timeline: [], tasks: [], pending: [], ledger: [], leases: [], busy: false, draft: null, connection: "connecting", agenda: null, memory: null, heartbeatTick: 0, extPlugins: [], feedback: null, nodes: null,
};

function upsert(timeline: TimelineItem[], item: TimelineItem) {
  const index = timeline.findIndex(existing => existing.id === item.id);
  if (index === -1) return [...timeline, item].sort((a, b) => a.at - b.at);
  const next = timeline.slice();
  next[index] = item;
  return next;
}

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "snapshot":
      return { ...state, ...action.snapshot, draft: null };
    case "timeline": {
      const draft = state.draft?.id === action.item.id ? null : state.draft;
      return { ...state, timeline: upsert(state.timeline, action.item), draft };
    }
    case "delta":
      // A late delta for an answer that already settled must not resurrect the draft.
      if (state.timeline.some(item => item.id === action.id)) return state;
      return { ...state, draft: { id: action.id, text: action.text } };
    case "tasks":
      return { ...state, tasks: action.tasks };
    case "pending":
      return { ...state, pending: action.pending };
    case "ledger":
      return { ...state, ledger: action.ledger };
    case "busy":
      return { ...state, busy: action.busy, draft: action.busy ? state.draft : null };
    case "connection":
      return { ...state, connection: action.connection };
    case "agenda":
      return { ...state, agenda: action.agenda };
    case "memory":
      return { ...state, memory: action.memory };
    case "notifications":
      return { ...state, notifications: action.notifications };
    case "watches":
      return { ...state, watches: action.watches };
    case "extPlugins":
      return { ...state, extPlugins: action.extPlugins };
    case "feedback":
      return { ...state, feedback: action.feedback };
    case "nodes":
      return { ...state, nodes: action.nodes };
    case "schedules":
      return { ...state, schedules: action.schedules };
    case "heartbeat":
      return { ...state, heartbeatTick: state.heartbeatTick + 1 };
  }
}

export function userPending(state: Pick<State, "pending">) {
  return state.pending.filter(request => request.audience === "user");
}
