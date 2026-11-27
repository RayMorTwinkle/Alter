import { Feedback } from "./feedback.ts";
import { feedbackView } from "./feedback-service.ts";
import { contentText } from "@earendil-works/pi-ai";
import { Audit, Requests, type PermissionState } from "./broker.ts";
import { Notifications, type Notification } from "./notifications.ts";
import { Leases, leaseWindow, type openAlter } from "./main.ts";
import {
  context, InboxDoc, LiveDoc, type ConversationDocToken, type Cursor, type EntryRecord, type JsonObject,
} from "./runtime.ts";
import { ScheduledTasks, type ScheduledTask } from "./scheduled-tasks.ts";
import { watchList, type WatchItem } from "./watch.ts";
import { Ledger, Tasks, type LedgerEntry, type TaskRecord } from "./state.ts";
import { heartbeatKind } from "./heartbeat-state.ts";
import { startsTurn } from "./wake.ts";
import { assistantId, queuedItem, timelineEntries, type TimelineItem } from "./timeline.ts";

export type AlterApp = Awaited<ReturnType<typeof openAlter>>;
export type AlterSurface = { id: string; label?: string; start(app: AlterApp): Promise<() => Promise<void>> };
export async function startSurface(app: AlterApp, surface: AlterSurface) {
  const unregister = app.registerUserChannel(surface);
  try {
    const stop = await surface.start(app);
    return async () => { try { await stop(); } finally { unregister(); } };
  } catch (error) { unregister(); throw error; }
}

export type PermissionRequest = Omit<PermissionState["pending"][string], "argumentsJson" | "toolTask" | "wakeKey" | "leaseId" | "checking"> & { arguments: unknown };
type Task = Omit<TaskRecord, "watch" | "conversationId" | "worker" | "heartbeatReview" | "lastEntry" | "messages" | "wakeId" | "status"> & {
  status: Exclude<TaskRecord["status"], "cancelled">;
  taskId: string; conversationId: string; allow: string[]; pending: PermissionRequest[];
};
export type ToolTrace = { id: number; at: number; taskId: string; tool: string; effect: "read" | "write" | "irreversible"; decision: "park" | "allow" | "deny" };
export type SurfaceState = {
  traces: ToolTrace[];
  timeline: TimelineItem[]; tasks: Task[]; pending: PermissionRequest[]; ledger: LedgerEntry[];
  notifications: Notification[]; schedules: ScheduledTask[]; watches: WatchItem[];
  leases: { capability: string; idleTurns: number; window: number }[]; busy: boolean;
};
type Delta = { id: string; text: string };
type Payloads = Pick<SurfaceState, "traces" | "tasks" | "pending" | "ledger" | "notifications" | "schedules" | "watches"> & {
  feedback: ReturnType<typeof feedbackView>; busy: { busy: boolean }; timeline: TimelineItem; delta: Delta;
};
export type SurfaceEvent = { [K in keyof Payloads]: { event: K; data: Payloads[K] } }[keyof Payloads];

const limit = 200;

// Both surfaces attach before resume. Seed the recent history once, then consume the
// runtime's synchronous observations. HTTP clients can snapshot and subscribe in one tick.
export async function observeSurface({ harness, main }: AlterApp, emit: (event: SurfaceEvent, inputSource?: string) => void) {
  const state: SurfaceState = { traces: [], timeline: [], schedules: [], watches: [], notifications: [], tasks: [], pending: [], ledger: [], leases: [], busy: false };
  const turn: Parameters<typeof timelineEntries>[1] = {};
  let partial: Delta | undefined;
  let records: Record<string, TaskRecord> = {};
  let streamedId: string | undefined;
  const shownQueued = new Set<number>();
  const subscriptions: { detach(): void }[] = [];
  const detach = () => subscriptions.forEach(sub => sub.detach());

  function add(item: TimelineItem, publish = true) {
    const runner = item.taskId && records[item.taskId]?.runner;
    if (runner) item = { ...item, runner };
    const timeline = state.timeline;
    const index = timeline.findIndex(old => old.id === item.id);
    if (index >= 0) {
      if ((item.kind === "tool" && item.isError !== undefined) || item.kind === "message" || item.silent) {
        timeline[index] = item;
        if (publish) emit({ event: "timeline", data: item }, turn.source);
      }
      return;
    }
    // Order by event time even when queued items are placed later or an audit
    // document is replayed on startup. Preserve entry order for millisecond ties.
    timeline.push(item);
    if (timeline.length > 1 && timeline[timeline.length - 2]!.at > item.at) timeline.sort((a, b) => a.at - b.at);
    if (timeline.length > limit) timeline.shift();
    if (publish) emit({ event: "timeline", data: item }, turn.source);
  }

  function updateTasks() {
    state.tasks = Object.entries(records).map(([taskId, { worker, heartbeatReview, lastEntry, messages, wakeId, status, watch, ...task }]) => ({
      ...task, allow: [], taskId, status: status === "cancelled" ? "failed" : status, ...(status === "cancelled" && { failure: status }),
      conversationId: String(task.conversationId), pending: state.pending.filter(req => req.taskId === taskId),
    }));
    emit({ event: "tasks", data: state.tasks });
  }

  async function watch<T extends JsonObject>(token: ConversationDocToken<T>, update: (value: Readonly<T>) => void) {
    let advanced = false;
    const observation = await harness.observeDoc(token, main.id, {
      advance(call) { if (call.kind === "value") { advanced = true; update(call.value); } }, end() {},
    }, context);
    if (!observation) throw new Error("Surface document was not initialized");
    subscriptions.push(observation);
    if (!advanced) update(observation.value);
  }

  try {
    await main.commit(async tx => {
      await tx.doc(Tasks, main.id);
      await tx.doc(Requests, main.id);
      await tx.doc(Audit, main.id);
      await tx.doc(Notifications, main.id);
      await tx.doc(Ledger, main.id);
      await tx.doc(Leases, main.id);
      await tx.doc(InboxDoc, main.id);
      await tx.doc(LiveDoc, main.id);
    }, context);
    let cursor: Cursor | undefined;
    const recent: TimelineItem[] = [];
    const segment: EntryRecord[] = [];
    let latest = true;
    function readTurn() {
      const historyTurn = latest ? turn : {};
      const items = segment.reverse().flatMap(entry => timelineEntries(entry, historyTurn));
      const byId = new Map(items.map(item => [item.id, item]));
      recent.push(...[...byId.values()].reverse().slice(0, limit - recent.length));
      segment.length = 0;
      latest = false;
    }
    do {
      const page = await main.entries({}, limit, cursor, context);
      for (const entry of page.items) {
        segment.push(entry);
        if (startsTurn(entry)) readTurn();
        if (recent.length >= limit) break;
      }
      cursor = page.next;
    } while (cursor && recent.length < limit);
    if (segment.length) readTurn();
    await watch(Tasks, value => {
      records = value.byId;
      updateTasks();
      const watches = watchList(records);
      if (JSON.stringify(watches) !== JSON.stringify(state.watches)) {
        state.watches = watches;
        emit({ event: "watches", data: watches });
      }
    });
    for (const item of recent.reverse()) add(item, false);
    // A parked auto action is user-visible even after the request is answered. The
    // append-only audit supplies its original time and a stable ID after restart.
    let auditLength = 0;
    let seeding = true;
    await watch(Audit, ({ entries }) => {
      let count = 0;
      function permissionAt(i: number) {
        const row = entries[i]!;
        if (row.decision !== "park" || (!row.audience && records[row.taskId]?.permission !== "auto")) return;
        add({ id: `approval-${i}`, kind: "permission", text: `请求用户审批：${row.tool}`, at: row.at, taskId: row.taskId }, !seeding);
        count++;
      }
      if (seeding) {
        for (let i = entries.length - 1; i >= 0 && count < limit; i--) permissionAt(i);
      } else {
        for (let i = auditLength; i < entries.length; i++) permissionAt(i);
      }
      if (seeding || auditLength !== entries.length) {
        const start = Math.max(0, entries.length - 80);
        state.traces = entries.slice(start).map(({ at, taskId, tool, effect, decision }, i) =>
          ({ id: start + i, at, taskId, tool, effect, decision }));
        if (!seeding) emit({ event: "traces", data: state.traces });
      }
      auditLength = entries.length;
    });
    seeding = false;
    await watch(Requests, value => {
      state.pending = Object.values(value.pending).filter(req => !req.checking && req.audience === "user").map(({ toolTask, wakeKey, checking, leaseId, argumentsJson, ...req }) => ({
        ...req, arguments: JSON.parse(argumentsJson),
      }));
      emit({ event: "pending", data: state.pending });
      updateTasks();
    });
    await watch(ScheduledTasks, value => {
      state.schedules = Object.values(value.byId).map(row => row.item);
      emit({ event: "schedules", data: state.schedules });
    });
    await watch(Feedback, value => emit({ event: "feedback", data: feedbackView(value) }));
    await watch(Notifications, value => { state.notifications = value.entries; emit({ event: "notifications", data: state.notifications }); });
    await watch(Ledger, value => { state.ledger = value.entries; emit({ event: "ledger", data: state.ledger }); });
    await watch(Leases, value => {
      state.leases = Object.entries(value.lastUsed).map(([capability, last]) => ({
        capability, idleTurns: Math.max(0, value.turns - last), window: leaseWindow,
      }));
    });
    await watch(InboxDoc, value => {
      for (const item of value.items) {
        if (item.mode === "write" || item.entry?.kind === heartbeatKind || shownQueued.has(item.id)) continue;
        shownQueued.add(item.id);
        add(queuedItem(item));
      }
    });
    await watch(LiveDoc, live => {
      const busy = live.run !== undefined;
      if (state.busy !== busy) { state.busy = busy; emit({ event: "busy", data: { busy } }); }
      const msg = live.generation?.message;
      const text = msg && contentText(msg.content);
      if (turn.heartbeat || !live.run || !msg || !text) { partial = undefined; return; }
      const id = assistantId(live.run.taskId, msg.timestamp);
      if (partial?.id !== id || partial.text !== text) {
        streamedId = id;
        partial = { id, text };
        emit({ event: "delta", data: partial });
      }
    });
    subscriptions.push(harness.observeCommits({
      advance({ changes }) {
        // Placement and its transcript entry share a commit. Avoid a second echo
        // even if 200 newer items already pushed this queued input out of the window.
        const placed = new Set<number>();
        for (const change of changes) {
          if (change.type !== "submission" || change.value.conversationId !== main.id) continue;
          const submission = change.value;
          if (submission.status !== "queued" && shownQueued.delete(submission.id) && submission.entry !== undefined) {
            placed.add(submission.entry);
          }
        }
        for (const change of changes) {
          if (change.type === "entry" && change.value.conversationId === main.id) {
            for (const item of timelineEntries(change.value, turn)) {
              // A follow-up is visible in the inbox before it participates in a model turn.
              if (placed.has(change.value.id)) continue;
              // Short answers can finish before pi.live's first progress tick.
              if (item.kind === "assistant" && !turn.heartbeat && streamedId !== item.id) {
                emit({ event: "delta", data: { id: item.id, text: item.text } });
              }
              add(item);
            }
          }
        }
      }, end() {},
    }));
    return {
      snapshot: (): SurfaceState => ({ ...state, timeline: [...state.timeline] }),
      get partial() { return partial; }, detach,
    };
  } catch (error) { detach(); throw error; }
}

export async function stopMainTurn({ main, harness }: AlterApp) {
  let run = (await harness.snapshot(LiveDoc, main.id, context))?.run;
  if (!run) return;
  const first = run.first;
  do {
    await harness.abortTask(run.taskId, context);
    await harness.waitForTask(run.taskId, context);
    // A tool round can hand the same turn to a successor generation while the
    // stop is admitted. Follow that handover without aborting the next input.
    run = (await harness.snapshot(LiveDoc, main.id, context))?.run;
  } while (first !== undefined && run?.first === first);
  // Aborting just the active generation preserves queued messages and background tasks.
  // If this left an inbox, place it under the same transaction that checks for a new run.
  await main.commit(async tx => {
    if (!(await tx.doc(LiveDoc, main.id)).run && (await tx.doc(InboxDoc, main.id)).items.length) {
      await main.submit(tx, { type: "continue" });
    }
  }, context);
}
