import { contentText } from "@earendil-works/pi-ai";
import { Audit, Requests, type PermissionState } from "./broker.ts";
import { Notifications, type Notification } from "./notifications.ts";
import { Leases, leaseWindow, type openAlter } from "./main.ts";
import {
  context, InboxDoc, LiveDoc, type ConversationDocToken, type Cursor, type JsonObject,
} from "./runtime.ts";
import { Ledger, Tasks, type LedgerEntry, type TaskRecord } from "./state.ts";
import { assistantId, queuedItem, timelineEntries, type TimelineItem } from "./timeline.ts";

export type AlterApp = Awaited<ReturnType<typeof openAlter>>;
export type AlterSurface = { id: string; start(app: AlterApp): Promise<() => Promise<void>> };
export type PermissionRequest = Omit<PermissionState["pending"][string], "argumentsJson" | "toolTask" | "wakeKey" | "checking"> & { arguments: unknown };
type Task = Omit<TaskRecord, "conversationId" | "worker" | "lastEntry" | "messages" | "wakeId" | "endedAt" | "status"> & {
  status: Exclude<TaskRecord["status"], "cancelled">;
  taskId: string; conversationId: string; allow: string[]; pending: PermissionRequest[];
};
export type SurfaceState = {
  timeline: TimelineItem[]; tasks: Task[]; pending: PermissionRequest[]; ledger: LedgerEntry[];
  notifications: Notification[];
  leases: { capability: string; idleTurns: number; window: number }[]; busy: boolean;
};
type Delta = { id: string; text: string };
type Payloads = Pick<SurfaceState, "tasks" | "pending" | "ledger" | "notifications"> & {
  busy: { busy: boolean }; timeline: TimelineItem; delta: Delta;
};
export type SurfaceEvent = { [K in keyof Payloads]: { event: K; data: Payloads[K] } }[keyof Payloads];

const limit = 200;

// Both surfaces attach before resume. Seed the recent history once, then consume the
// runtime's synchronous observations. HTTP clients can snapshot and subscribe in one tick.
export async function observeSurface({ harness, main }: AlterApp, emit: (event: SurfaceEvent, inputSource?: string) => void) {
  const state: SurfaceState = { timeline: [], notifications: [], tasks: [], pending: [], ledger: [], leases: [], busy: false };
  let inputSource: string | undefined;
  let partial: Delta | undefined;
  let records: Record<string, TaskRecord> = {};
  let streamedId: string | undefined;
  const shownQueued = new Set<number>();
  const subscriptions: { detach(): void }[] = [];
  const detach = () => subscriptions.forEach(sub => sub.detach());

  function add(item: TimelineItem, publish = true) {
    const timeline = state.timeline;
    if (timeline.some(old => old.id === item.id)) return;
    // Order by event time even when queued items are placed later or an audit
    // document is replayed on startup. Preserve entry order for millisecond ties.
    timeline.push(item);
    if (timeline.length > 1 && timeline[timeline.length - 2]!.at > item.at) timeline.sort((a, b) => a.at - b.at);
    if (timeline.length > limit) timeline.shift();
    if (publish) emit({ event: "timeline", data: item }, inputSource);
  }

  function updateTasks() {
    state.tasks = Object.entries(records).map(([taskId, { worker, lastEntry, messages, wakeId, endedAt, status, ...task }]) => ({
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
    do {
      const page = await main.entries({}, limit, cursor, context);
      for (const entry of page.items) {
        const items = timelineEntries(entry).reverse();
        inputSource ??= items.find(item => item.kind === "user")?.source;
        if (recent.length < limit) recent.push(...items);
      }
      cursor = page.next;
    } while (cursor && (recent.length < limit || !inputSource));

    for (const item of recent.reverse()) add(item, false);
    await watch(Tasks, value => { records = value.byId; updateTasks(); });
    // A parked auto action is user-visible even after the request is answered. The
    // append-only audit supplies its original time and a stable ID after restart.
    let auditLength = 0;
    let seeding = true;
    await watch(Audit, ({ entries }) => {
      let count = 0;
      function permissionAt(i: number) {
        const row = entries[i]!;
        if (row.decision !== "park" || (!row.audience && !row.tainted && records[row.taskId]?.permission !== "auto")) return;
        add({ id: `approval-${i}`, kind: "permission", text: `请求用户审批：${row.tool}`, at: row.at, taskId: row.taskId }, !seeding);
        count++;
      }
      if (seeding) {
        for (let i = entries.length - 1; i >= 0 && count < limit; i--) permissionAt(i);
      } else {
        for (let i = auditLength; i < entries.length; i++) permissionAt(i);
      }
      auditLength = entries.length;
    });
    seeding = false;
    await watch(Requests, value => {
      state.pending = Object.values(value.pending).filter(req => !req.checking && req.audience === "user").map(({ toolTask, wakeKey, checking, argumentsJson, ...req }) => ({
        ...req, arguments: JSON.parse(argumentsJson),
      }));
      emit({ event: "pending", data: state.pending });
      updateTasks();
    });
    await watch(Notifications, value => { state.notifications = value.entries; emit({ event: "notifications", data: state.notifications }); });
    await watch(Ledger, value => { state.ledger = value.entries; emit({ event: "ledger", data: state.ledger }); });
    await watch(Leases, value => {
      state.leases = Object.entries(value.lastUsed).map(([capability, last]) => ({
        capability, idleTurns: Math.max(0, value.turns - last), window: leaseWindow,
      }));
    });
    await watch(InboxDoc, value => {
      for (const item of value.items) {
        if (item.mode === "write" || shownQueued.has(item.id)) continue;
        shownQueued.add(item.id);
        add(queuedItem(item));
      }
    });
    await watch(LiveDoc, live => {
      const busy = live.run !== undefined;
      if (state.busy !== busy) { state.busy = busy; emit({ event: "busy", data: { busy } }); }
      const msg = live.generation?.message;
      const text = msg && contentText(msg.content);
      if (!live.run || !msg || !text) { partial = undefined; return; }
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
            for (const item of timelineEntries(change.value)) {
              // A follow-up is visible in the inbox before it participates in a model turn.
              if (item.kind === "user") inputSource = item.source;
              if (placed.has(change.value.id)) continue;
              // Short answers can finish before pi.live's first progress tick.
              if (item.kind === "assistant" && streamedId !== item.id) {
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
