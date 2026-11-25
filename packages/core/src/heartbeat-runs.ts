import { contentText } from "@earendil-works/pi-ai";
import { defineDocFamily } from "@earendil-works/pi-durable";
import { recordAdoption } from "./heartbeat-state.ts";
import { context, LiveDoc, conversationDoc, ROOT_CONVERSATION_ID, type Conversation, type Cursor, type EntryId, type Harness, type Tx } from "./runtime.ts";
import { startsTurn } from "./wake.ts";
import { Reports, type ReportView } from "./report-state.ts";
import { Schedules } from "./scheduler.ts";

export type HeartbeatReason = "inactive" | "disabled" | "outside-hours" | "busy" | "busy-timeout" | "recent-activity" | "unchanged" | "budget";
export type HeartbeatRun = {
  id: string; at: number; finishedAt: number | null; status: "ran" | "skipped" | "deferred"; skipReason: HeartbeatReason | null;
  counts: { goals: number; memories: number; chat: number; agenda: number; tasks: number; digests: number };
  actions: { tool: string; id?: string; level?: "now" | "digest" }[];
  notified: boolean; finalReply: string; tokens: number; feedback: "useful" | "useless" | null;
};
type RunEvent = { type: "start" | "end"; id: string } | { type: "feedback"; id: string; feedback: "useful" | "useless" };
export type HeartbeatEvent = RunEvent | { type: "schedule"; nextAt: number | null } | { type: "report"; report: ReportView };
const Runs = defineDocFamily<{ run?: HeartbeatRun }, null>({ kind: "alter.heartbeat-run", version: 1,
  family: true, scope: "session", initial: () => ({}), checkpointWhen: () => false });
const Index = conversationDoc<{ recent: string[]; pending: string[]; event?: RunEvent }>("heartbeat-runs",
  () => ({ recent: [], pending: [] }));

export async function recordRun(tx: Tx, run: HeartbeatRun) {
  (await tx.doc(Runs, run.id, null)).run = run;
  const index = await tx.doc(Index, ROOT_CONVERSATION_ID);
  index.recent = [run.id, ...index.recent.slice(0, 49)];
  if (run.status === "ran") index.pending.push(run.id);
  index.event = { type: run.status === "ran" ? "start" : "end", id: run.id };
}

export async function recentRuns(tx: Tx) {
  const index = await tx.doc(Index, ROOT_CONVERSATION_ID);
  const runs: HeartbeatRun[] = [];
  for (const id of index.recent) {
    const run = (await tx.doc(Runs, id, null)).run!;
    runs.push({ ...run, counts: { ...run.counts }, actions: run.actions.map(action => ({ ...action })) });
  }
  return runs;
}

export async function rateRun(tx: Tx, id: string, feedback: NonNullable<HeartbeatRun["feedback"]>) {
  if (!/^heartbeat-[0-9a-f-]{36}$/.test(id)) return "missing";
  const run = (await tx.doc(Runs, id, null)).run;
  if (!run) return "missing";
  if (run.status !== "ran") return "skipped";
  if (feedback !== run.feedback) {
    run.feedback = feedback;
    await recordAdoption(tx, id, { id, useful: feedback === "useful" });
    const index = await tx.doc(Index, ROOT_CONVERSATION_ID);
    index.event = { type: "feedback", id, feedback };
  }
  return "ok";
}

function actionId(tool: string, result: string) {
  if (!["dispatch_task", "watch", "watch_create", "send_message", "schedule_create", "schedule_set", "task_stop"].includes(tool)) return;
  if (/^[\w.-]+$/.test(result)) return result;
  if (result.startsWith("{")) {
    try {
      const record = JSON.parse(result);
      const id = record.id ?? record.taskId ?? record.watchId ?? record.scheduleId;
      if (typeof id === "string") return id;
    } catch { /* A tool may return a free-form description. */ }
  }
}

export async function recordHeartbeatReply(tx: Tx, id: string) {
  const run = (await tx.doc(Runs, id, null)).run;
  if (run) run.notified = true;
}

async function finish(tx: Tx, id: string, at: number, activeFirst?: EntryId) {
  const submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, id);
  if (submission?.type !== "input" || (submission.status !== "done" && submission.status !== "unanswered")) return;
  if (activeFirst !== undefined && submission.entry === activeFirst) return;
  const run = (await tx.doc(Runs, id, null)).run;
  if (!run || run.finishedAt !== null) return;
  let cursor: Cursor | undefined;
  if (submission.entry !== undefined) {
    entries: do {
      const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending",
        minEntryId: submission.entry, maxEntryId: submission.answer }, 100, cursor);
      for (const entry of page.items) {
        if (entry.id !== submission.entry && startsTurn(entry)) break entries;
        for (const msg of entry.model ?? []) {
          if (msg.role === "assistant") {
            run.tokens += msg.usage.totalTokens;
            run.finalReply = contentText(msg.content);
          }
          if (msg.role !== "toolResult" || msg.isError) continue;
          const tool = msg.toolName;
          const result = contentText(msg.content).trim();
          const action: HeartbeatRun["actions"][number] = { tool };
          const id = actionId(tool, result);
          if (id) action.id = id;
          // A pre-0025 inspection can finish recovery with an already delivered tool result.
          if (tool === "send_message" && action.id) {
            action.level = "now";
            run.notified = true;
          }
          run.actions.push(action);
        }
      }
      cursor = page.next;
    } while (cursor);
  }
  run.finishedAt = at;
  const index = await tx.doc(Index, ROOT_CONVERSATION_ID);
  index.pending = index.pending.filter(pending => pending !== id);
  index.event = { type: "end", id };
}

export async function observeHeartbeatRuns(harness: Harness, main: Conversation, now: () => number) {
  // The answer settles before afterRun commits its notification. Finalize once the run leaves pi.live,
  // including when Stop cancels its afterRun work or an older run resumes without a delivery task.
  async function finishPending() {
    await main.commit(async tx => {
      const first = (await tx.doc(LiveDoc, main.id)).run?.first;
      for (const id of [...(await tx.doc(Index, main.id)).pending]) await finish(tx, id, now(), first);
    }, context);
  }
  let draining = Promise.resolve();
  let previous: number | undefined;
  const sub = await harness.observeDoc(LiveDoc, main.id, {
    advance(call) {
      if (call.kind !== "value") return;
      const first = call.value.run?.first;
      if (previous !== undefined && previous !== first) {
        draining = draining.then(finishPending).catch(error => console.error("Failed to finalize heartbeat", error));
      }
      previous = first;
    }, end() {},
  }, context);
  previous = sub?.value.run?.first;
  await finishPending();
  return async () => { sub?.detach(); await draining; };
}

export async function subscribeHeartbeat(harness: Harness, listener: (event: HeartbeatEvent) => void) {
  const runs = await harness.observeDoc(Index, ROOT_CONVERSATION_ID, {
    advance(call) { if (call.kind === "value" && call.value.event) listener(call.value.event); }, end() {},
  }, context);
  let previous: number | null | undefined;
  const schedules = await harness.observeDoc(Schedules, ROOT_CONVERSATION_ID, {
    advance(call) {
      if (call.kind !== "value") return;
      const item = call.value.byId["adaptive-heartbeat"]?.item;
      const nextAt = item?.status === "scheduled" ? item.at : null;
      if (previous !== nextAt) listener({ type: "schedule", nextAt });
      previous = nextAt;
    }, end() {},
  }, context);
  const initial = schedules?.value.byId["adaptive-heartbeat"]?.item;
  previous = initial?.status === "scheduled" ? initial.at : null;
  let lastReport: string | undefined;
  const reports = await harness.observeDoc(Reports, ROOT_CONVERSATION_ID, {
    advance(call) {
      if (call.kind !== "value" || !call.value.view) return;
      const value = JSON.stringify(call.value.view);
      if (value !== lastReport) listener({ type: "report", report: call.value.view });
      lastReport = value;
    }, end() {},
  }, context);
  lastReport = JSON.stringify(reports?.value.view);
  return () => { runs?.detach(); schedules?.detach(); reports?.detach(); };
}
