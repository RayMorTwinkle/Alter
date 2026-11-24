import { Ledger } from "./state.ts";
import { context, conversationDoc, InboxDoc, LiveDoc, type Conversation, type ConversationId, type Cursor, type EntryRecord, type Harness, type LiveState, type Tx } from "./runtime.ts";

export type Wake = { wakeId: string; wakeSource: string; wakeAt: number; thinking?: "low" | "medium" | "high" | "max" };
export const Wakes = conversationDoc<{ byId: Record<string, Wake> }>("wakes", () => ({ byId: {} }));

export async function activeWake(tx: Tx, id: ConversationId, at: number) {
  const run = (await tx.doc(LiveDoc, id)).run;
  if (run) return recordWake(tx, id, run, at);
}

async function recordWake(tx: Tx, id: ConversationId, run: NonNullable<LiveState["run"]>, at: number) {
  const input = run.inputs[0];
  const wakeId = input === undefined ? `wake-run-${run.first ?? run.taskId}` : `wake-${input}`;
  const { byId } = await tx.doc(Wakes, id);
  if (byId[wakeId]) return { ...byId[wakeId] };
  const submission = input === undefined ? undefined : await tx.submission(input);
  const first = submission?.entry ?? run.first;
  const entry = first === undefined ? undefined : await tx.entry(first);
  const data = entry?.data;
  const meta = data && typeof data === "object" && !Array.isArray(data) ? data : undefined;
  let wakeSource = "unknown";
  if (entry?.kind === "alter.user-input" && typeof meta?.source === "string") {
    wakeSource = ["web", "feishu", "cli"].includes(meta.source) ? "user-" + meta.source : meta.source;
  } else if (entry?.kind === "alter.task-report") wakeSource = meta?.wakeSource === "watch" ? "watch" : "report";
  else if (entry?.kind === "alter.triage") wakeSource = "triage";
  else if (entry?.kind === "alter.report-due") wakeSource = "report-due";
  else if (entry?.kind === "alter.heartbeat") wakeSource = "heartbeat";
  else if (entry?.kind === "alter.schedule" && !/^expired-permission-/.test(submission?.requestId ?? "")) wakeSource = "schedule";
  else if (/^(expired-)?permission-/.test(submission?.requestId ?? "")) wakeSource = "approval";
  const thinking = meta?.thinking;
  const wake: Wake = { wakeId, wakeSource, wakeAt: at };
  if (wakeSource === "schedule" && (thinking === "low" || thinking === "medium" || thinking === "high" || thinking === "max")) wake.thinking = thinking;
  byId[wakeId] = wake;
  return wake;
}

export function isInlineTaskReport(entry: Pick<EntryRecord, "kind" | "data">) {
  const data = entry.data;
  return entry.kind === "alter.task-report" && !!data && typeof data === "object" && !Array.isArray(data) && data.inline === true;
}

export function startsTurn(entry: EntryRecord) {
  return entry.kind !== "pi.compaction" && !isInlineTaskReport(entry) && entry.model?.some(msg => msg.role === "user");
}

export const PendingReplies = conversationDoc<{ ids: string[] }>("pending-replies", () => ({ ids: [] }));

async function settleReply(tx: Tx, main: ConversationId, id: string) {
  const pending = await tx.doc(PendingReplies, main);
  if (!pending.ids.includes(id)) return;
  const input = await tx.submissionByRequest(main, id);
  if (input?.type !== "input" || (input.status !== "done" && input.status !== "unanswered")) return;
  pending.ids = pending.ids.filter(other => other !== id);
  if (input.entry === undefined) return; // Withdrawn before it triggered a turn.
  let cursor: Cursor | undefined;
  let at = 0;
  entries: do {
    const page = await tx.scanEntries({ conversationId: main, order: "ascending", minEntryId: input.entry,
      maxEntryId: input.answer }, 64, cursor);
    for (const entry of page.items) {
      if (entry.id === input.entry) at = entry.model?.[0]?.timestamp ?? 0;
      else if (startsTurn(entry)) break entries;
      if (entry.model?.some(msg => msg.role === "assistant" && msg.content.some(p => p.type === "toolCall" && p.name === "send_message"))) return;
    }
    cursor = page.next;
  } while (cursor);
  (await tx.doc(Ledger, main)).entries.push({ taskId: "main", kind: "unreplied", summary: "用户消息未回复",
    at, refs: [{ kind: "input", ref: id }] });
}

export async function observeWakes(harness: Harness, main: Conversation, now: () => number) {
  await main.commit(async tx => {
    for (const id of [...(await tx.doc(PendingReplies, main.id)).ids]) await settleReply(tx, main.id, id);
  }, context);
  let replies = Promise.resolve();
  const settlements = harness.observeCommits({ advance({ changes }) {
    for (const change of changes) {
      if (change.type !== "submission" || change.value.conversationId !== main.id || change.value.type !== "input") continue;
      const { status, requestId } = change.value;
      if (requestId && (status === "done" || status === "unanswered")) {
        replies = replies.then(() => main.commit(tx => settleReply(tx, main.id, requestId), context))
          .catch(error => console.error("Failed to settle user reply", requestId, error));
      }
    }
  }, end() {} });
  let previous: number | undefined;
  let pending = Promise.resolve();
  function observe(run?: LiveState["run"]) {
    if (!run) {
      // A failed or interrupted run can leave reports queued until the next input.
      pending = main.commit(async tx => {
        if ((await tx.doc(LiveDoc, main.id)).run) return;
        const { items } = await tx.doc(InboxDoc, main.id);
        if (items.some(item => item.mode !== "write" && item.entry?.kind === "alter.task-report")) {
          await main.submit(tx, { type: "continue" });
        }
      }, context).catch(error => { console.error("Failed to resume queued task report", error); });
      return;
    }
    const input = run.inputs[0];
    if (input === undefined || input === previous) return;
    previous = input;
    const at = now();
    pending = main.commit(tx => recordWake(tx, main.id, run, at), context)
      .then(() => {}, error => { console.error("Failed to record main wake", error); });
  }
  const sub = await harness.observeDoc(LiveDoc, main.id, {
    advance(call) { if (call.kind === "value") observe(call.value.run); }, end() {},
  }, context);
  if (sub) observe(sub.value.run);
  return async () => { sub?.detach(); settlements.detach(); await Promise.all([pending, replies]); };
}
