import { randomUUID } from "node:crypto";
import { mergeCorrection, type FeedbackCall } from "./feedback-model.ts";
import { calendarTime } from "./calendar-time.ts";
import { day, Feedback, FeedbackError, featureQuestion, feedbackEditors, fixedMetric, knownReplyLength, memoryVersion, originalOption, lastInteraction, issueQuestions, seedQuestions, syncGuesses,
  type Answer, type Bank, type Change, type Issued } from "./feedback.ts";
import { interacted, Preferences, type FeedbackSettings } from "./feedback-settings.ts";
import { openFeedbackTables } from "./feedback-tables.ts";
import { feedbackStats } from "./feedback-stats.ts";
import type { createMemory } from "./memory.ts";
import { MemoryConflict, sentence, type MemoryEntry, type Operation } from "./memory-store.ts";
import { addNotification } from "./notifications.ts";
import { context, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID as root, type Conversation, type Harness, type Tx } from "./runtime.ts";
import type { createScheduler } from "./scheduler.ts";

type Param = Extract<Issued["effect"], { kind: "param" }>;
function current(settings: FeedbackSettings, e: Param) {
  if (e.key === "triagePreference" || e.key === "permissionNotes") return settings[e.key][e.scope!] ?? null;
  return settings[e.key];
}
function write(settings: FeedbackSettings, e: Param, value: string | number | null) {
  switch (e.key) {
    case "permissionNotes": case "triagePreference":
      if (value === null) delete settings[e.key][e.scope!];
      else if (e.key === "permissionNotes") settings.permissionNotes[e.scope!] = String(value);
      else if (value === "now" || value === "digest" || value === "silent") settings.triagePreference[e.scope!] = value;
      else throw new Error("Invalid triage preference");
      break;
    case "heartbeatBias": case "reportFrequency": settings[e.key] = Number(value); break;
    case "replyLength": settings.replyLength = value === null ? null : String(value); break;
  }
}
function parseAnswer(i: Issued, input: Record<string, unknown>): Answer {
  const options = input.options ?? [];
  const other = typeof input.other === "string" ? input.other.trim() : undefined;
  if (!Array.isArray(options) || !options.every(o => typeof o === "string" && i.options.includes(o)) ||
    new Set(options).size !== options.length || (!i.multi && options.length > 1) || (!other && !options.length) ||
    (input.other !== undefined && (typeof input.other !== "string" || !i.allowOther || input.other.length > 2000)) ||
    Object.keys(input).some(k => k !== "options" && k !== "other")) throw new FeedbackError(400, "Invalid options or other text");
  const choice = originalOption(i, options[0]);
  if (i.effect.kind === "memory" && ((choice === "部分对" && !other) || (other && choice === "对"))) {
    throw new FeedbackError(400, "请在部分正确时写下修正，或单独填写其他内容");
  }
  return { options: i.options.filter(o => options.includes(o)), ...(other && { other }) };
}
function issue(bank: Bank, id: string) {
  if (!Object.hasOwn(bank.issues, id)) throw new FeedbackError(404, "Unknown feedback question");
  return bank.issues[id]!;
}
export function feedbackView(bank: Bank) {
  const issues = Object.values(bank.issues).sort((a, b) => b.askedAt - a.askedAt);
  return { pending: issues.filter(i => i.status === "pending"), history: issues.filter(i => i.status !== "pending"),
    changes: Object.values(bank.changes).reverse().sort((a, b) => b.at - a.at) };
}

export function createFeedback(main: () => Conversation, harness: () => Harness, memory: ReturnType<typeof createMemory>, scheduler: ReturnType<typeof createScheduler>,
  now: () => number, timeZone: string, call: FeedbackCall, dir?: string) {
  let tables: Awaited<ReturnType<typeof openFeedbackTables>>;
  const time = calendarTime(timeZone);
  const commit = <T>(f: (tx: Tx) => Promise<T>) => main().commit(f, context);
  function syncEntries(bank: Bank, at: number) {
    const entries = memory.store.entries();
    syncGuesses(bank, entries.filter(e => e.guess), at);
    if (knownReplyLength(entries)) {
      for (const i of Object.values(bank.issues)) if (i.status === "pending" && i.candidateId === "style:length") i.status = "expired";
    }
  }
  function matchesGuess(i: Issued, e: MemoryEntry | undefined): e is MemoryEntry {
    return !!e?.guess && !e.supersededBy && (i.memoryVersion ? i.memoryVersion === memoryVersion(e)
      : i.prompt === "我推测「" + e.title + "」：" + e.body + "。这准确吗？");
  }
  type Correction = Awaited<ReturnType<typeof mergeCorrection>>;
  function memoryOp(i: Issued, source: string, bank: Bank, correction?: Correction): Operation {
    const a = i.answer!;
    if (i.effect.kind === "memory") {
      const id = i.effect.entryId;
      const e = memory.store.read(id);
      if (!matchesGuess(i, e)) {
        throw new MemoryConflict("猜测已更新，请重新取题");
      }
      if (!a.other && originalOption(i, a.options[0]) === "不对") return { op: "delete", id };
      const patch = correction ?? (a.other ? { body: a.other, title: sentence(a.other, 20), type: e.type } : undefined);
      return { op: "modify", id, patch: { guess: false, source, ...patch,
        ...(patch && e.type === "goal" && patch.type !== "goal" && { dueAt: null, status: "active" }) } };
    }
    if (i.effect.kind !== "param" || i.effect.key !== "replyLength") throw new Error("Expected a reply length effect");
    const text = a.other ?? String(i.effect.mapping[a.options[0]!]);
    const previous = Object.values(bank.changes).reverse().find(c => c.kind === "param" && c.key === "replyLength" && !c.undoneBy && c.memoryChangeId);
    const entry = previous && memory.store.changes("id=?", previous.memoryChangeId!)[0]?.snapshots[0]?.id;
    const existing = entry && memory.store.read(entry);
    if (existing && !existing.supersededBy) return { op: "modify", id: existing.id, patch: { body: text, source } };
    return { op: "add", entry: { type: "preference", title: "回复长短", body: text, source } };
  }
  async function finish(tx: Tx, bank: Bank, i: Issued, correction?: Correction) {
    const at = i.at!;
    const e = i.effect;
    const a = i.answer!;
    const change: Change = { id: i.id, issueId: i.id, at, kind: e.kind, key: "", before: null, after: null };
    const settings = await tx.doc(Preferences, root);
    if (e.kind === "memory" || (e.kind === "param" && e.key === "replyLength")) {
      const batch = "feedback:" + i.id;
      let receipt = memory.store.changes("batch=?", batch)[0];
      if (!receipt) {
        const op = memoryOp(i, "回访于 " + time.describe(at).iso.slice(0, 10), bank, correction);
        memory.store.apply([op], "write", batch);
        receipt = memory.store.changes("batch=?", batch)[0]!;
      }
      change.memoryChangeId = receipt.id;
      const snapshot = receipt.snapshots[0]!;
      if (e.kind === "memory") change.memoryAction = a.other ? "correct" : snapshot.after ? "confirm" : "delete";
      else change.memoryAction = snapshot.before ? "modify" : "add";
      change.key = snapshot.id;
      change.before = snapshot.before?.body ?? null;
      change.after = snapshot.after?.body ?? null;
    }
    if (e.kind === "param") {
      change.key = e.key + (e.scope ? "/" + e.scope : "");
      change.before = current(settings, e);
      const mapped = e.mapping[a.options[0]!];
      const value = a.other ?? mapped!;
      change.after = e.key === "permissionNotes" ? [change.before, value].filter(Boolean).join("\n") : value;
      write(settings, e, change.after);
    } else if (e.kind === "metric") {
      change.key = e.name;
      change.after = [...a.options, ...(a.other ? [a.other] : [])];
    }
    if (change.memoryChangeId || change.before !== change.after) {
      bank.changes[change.id] = change;
      i.changeIds = [change.id];
    }
    i.status = "answered";
    const q = bank.candidates[i.candidateId]!;
    q.answered++;
    q.lastAnsweredAt = at;
    if (q.source === "style") q.cooldownUntil = Math.max(q.cooldownUntil, at + 28 * day);
  }
  const completing = new Map<string, Promise<void>>();
  function complete(id: string) {
    const active = completing.get(id);
    if (active) return active;
    const work = applyAnswer(id).finally(() => completing.delete(id));
    completing.set(id, work);
    return work;
  }
  async function applyAnswer(id: string) {
    const pending = (await harness().snapshot(Feedback, root, context))?.issues[id];
    if (pending?.status !== "applying") return;
    let correction: Correction;
    if (pending.effect.kind === "memory" && pending.answer?.other && !memory.store.changes("batch=?", "feedback:" + id).length) {
      const entry = memory.store.read(pending.effect.entryId);
      if (matchesGuess(pending, entry)) correction = await mergeCorrection(call, entry, originalOption(pending, pending.answer.options[0]), pending.answer.other);
    }
    const error = await commit(async tx => {
      const bank = await tx.doc(Feedback, root);
      const i = issue(bank, id);
      if (i.status !== "applying") return;
      try { await finish(tx, bank, i, correction); }
      catch (e) {
        if (!(e instanceof MemoryConflict)) throw e;
        i.status = "expired";
        delete i.answer;
        return e.message;
      }
    });
    if (error) throw new FeedbackError(409, error);
  }
  async function answer(id: string, input: Record<string, unknown>) {
    await commit(async tx => {
      const bank = await tx.doc(Feedback, root);
      syncEntries(bank, now());
      const i = issue(bank, id);
      const answer = parseAnswer(i, input);
      if (i.status !== "pending") {
        if ((i.status === "applying" || i.status === "answered") && JSON.stringify(i.answer) === JSON.stringify(answer)) return;
        throw new FeedbackError(409, "Question already handled or expired");
      }
      i.answer = answer;
      i.at = now();
      i.status = "applying";
      await interacted(tx, i.at);
      // Only memory effects cross the memory.sqlite / harness transaction boundary.
      if (!(i.effect.kind === "memory" || (i.effect.kind === "param" && i.effect.key === "replyLength"))) await finish(tx, bank, i);
    });
    await complete(id);
  }
  async function skip(id: string) {
    await commit(async tx => {
      const bank = await tx.doc(Feedback, root);
      const i = issue(bank, id);
      if (i.status === "skipped") return;
      if (i.status !== "pending") throw new FeedbackError(409, "Question already handled or expired");
      i.at = now(); i.status = "skipped";
      const q = bank.candidates[i.candidateId]!;
      q.skipped++;
      q.cooldownUntil = i.at + 14 * day;
      await interacted(tx, i.at);
    });
  }
  function recordUndo(bank: Bank, c: Change, at: number, memoryChangeId?: string) {
    const id = "undo-" + c.id;
    bank.changes[id] = { id, undoOf: c.id, issueId: c.issueId, kind: "undo", key: c.key,
      at, before: c.after, after: c.before, ...(memoryChangeId && { memoryChangeId, memoryAction: "restore" }) };
    c.undoneBy = id;
    issue(bank, c.issueId).changeIds.push(id);
  }
  // Reconcile reversals made through the memory API, including an interrupted feedback undo.
  let memoryRevision = 0;
  async function syncMemory(tx: Tx) {
    const bank = await tx.doc(Feedback, root);
    syncEntries(bank, now());
    const settings = await tx.doc(Preferences, root);
    for (const undo of memory.store.changes("kind='undo' AND id>?", memoryRevision).reverse()) {
      const original = memory.store.changes("undoneBy=?", undo.id)[0];
      const c = original && Object.values(bank.changes).find(c => c.kind !== "undo" && c.memoryChangeId === original.id);
      if (!c || c.undoneBy) continue;
      const e = issue(bank, c.issueId).effect;
      if (e.kind === "param" && current(settings, e) === c.after) write(settings, e, c.before as string | number | null);
      recordUndo(bank, c, undo.at, undo.id);
    }
    return memory.store.revision();
  }
  async function undo(id: string) {
    await commit(async tx => {
      const bank = await tx.doc(Feedback, root);
      const c = Object.hasOwn(bank.changes, id) && bank.changes[id];
      if (!c) throw new FeedbackError(404, "Unknown feedback change");
      if (c.undoneBy) return;
      if (c.kind === "undo") throw new FeedbackError(409, "Cannot undo a reversal");
      const i = issue(bank, c.issueId);
      const e = i.effect;
      const settings = await tx.doc(Preferences, root);
      if (e.kind === "param") {
        const active = Object.values(bank.changes).filter(other => other.kind === "param" && other.key === c.key && !other.undoneBy);
        if (active.at(-1)?.id !== id || current(settings, e) !== c.after) throw new FeedbackError(409, "Preference has newer changes");
      }
      let memoryChangeId: string | undefined;
      if (c.memoryChangeId) {
        const receipt = memory.store.changes("id=?", c.memoryChangeId)[0]!;
        if (!receipt.undoneBy) memory.store.undo(receipt.id);
        memoryChangeId = memory.store.changes("id=?", receipt.id)[0]!.undoneBy;
      }
      if (e.kind === "param") write(settings, e, c.before as string | number | null);
      recordUndo(bank, c, now(), memoryChangeId);
      await interacted(tx, now());
    });
  }
  async function checkin(tx: Tx, at: number) {
    const bank = await tx.doc(Feedback, root);
    const consecutive = bank.visits.slice(-2);
    const doubled = consecutive.length === 2 && consecutive.every(batch =>
      Object.values(bank.issues).filter(i => i.batch === batch).every(i => i.status === "skipped"));
    const due = (bank.lastCheckin ?? bank.startedAt ?? at) + (doubled ? 14 : 7) * day;
    if (at < due) return { nextAt: due };
    if (at - await lastInteraction(tx) <= 3600_000 && !time.quietHours(at) &&
      !(await tx.doc(LiveDoc, root)).run && !(await tx.doc(InboxDoc, root)).items.length) {
      const questions = await issueQuestions(tx, { outlet: "checkin", limit: 5, minimum: 3 }, at);
      if (questions.length) {
        const batch = bank.issues[questions[0]!.id]!.batch;
        bank.visits.push(batch);
        bank.lastCheckin = at;
        await addNotification(tx, { id: batch, at, kind: "notify", source: "feedback", title: "每周回访",
          body: questions.map(q => q.prompt).join("\n"), level: "now", status: "unread" }, time.midnight(at));
        return { nextAt: at + 7 * day };
      }
    }
    return { nextAt: at + 15 * 60_000 };
  }
  scheduler.register("feedback", (_item, tx, at) => checkin(tx, at));
  async function start() {
    const runtimeId = randomUUID();
    const initialized = await commit(async tx => {
      const bank = await tx.doc(Feedback, root);
      const prefs = await tx.doc(Preferences, root);
      seedQuestions(bank, now());
      bank.runtimeId = runtimeId;
      const knownLength = prefs.replyLength !== null || knownReplyLength(memory.store.entries());
      const issues = Object.values(bank.issues);
      const metricBatches = new Set(issues.filter(i => fixedMetric(i) && ["applying", "answered", "skipped"].includes(i.status)).map(i => i.batch));
      for (const i of issues) {
        if (i.status !== "pending") continue;
        if (fixedMetric(i)) {
          if (metricBatches.has(i.batch)) i.status = "expired";
          metricBatches.add(i.batch);
        }
        const candidate = bank.candidates[i.candidateId];
        if (i.candidateId === "style:length" && knownLength ||
          i.source === "feature" && (!candidate?.feature || (!i.optionMap && i.prompt !== candidate.prompt))) i.status = "expired";
      }
      syncEntries(bank, now());
      return { first: bank.startedAt! + 7 * day, restoring: Object.values(bank.issues).filter(i => i.status === "applying").map(i => i.id) };
    });
    for (const id of initialized.restoring) {
      try { await complete(id); } catch (e) { if (!(e instanceof FeedbackError && e.status === 409)) throw e; }
    }
    memoryRevision = await commit(syncMemory);
    await scheduler.ensureAdaptive("feedback", "每周回访", initialized.first);
    tables = await openFeedbackTables(dir, harness());
    let queued = Promise.resolve();
    function sync() {
      queued = queued.then(async () => { memoryRevision = await commit(syncMemory); })
        .catch(error => console.error("Feedback memory sync failed", error));
    }
    feedbackEditors.set(runtimeId, { now, call, memory: () => memory.store.view({ expandTitles: true }) });
    memory.store.listeners.add(sync);
    return async () => { feedbackEditors.delete(runtimeId); memory.store.listeners.delete(sync); await queued; tables.close(); };
  }
  return { start, answer, skip, undo, checkin,
    active: () => commit(async tx => now() - await lastInteraction(tx) < 7 * day),
    view: () => tables.view(),
    stats: () => commit(tx => feedbackStats(tx, now(), timeZone)),
    more: (fromId?: string) => commit(async tx => {
      const bank = await tx.doc(Feedback, root);
      const at = now();
      let batch = bank.lastCheckin !== undefined && at - bank.lastCheckin < 7 * day ? bank.visits.at(-1) : undefined;
      if (fromId) {
        const i = issue(bank, fromId);
        batch = i.outlet === "checkin" ? i.batch : undefined;
        if (i.moreUsed) return [];
        i.moreUsed = true;
      }
      await interacted(tx, at);
      return issueQuestions(tx, { outlet: "checkin", limit: 5, batch }, at);
    }),
    feature: (id: string, name: string, installedAt = now()) => commit(async tx => { featureQuestion(await tx.doc(Feedback, root), id, name, installedAt); }),
    featureResult: (id: string, at: number) => commit(async tx => {
      const feature = (await tx.doc(Feedback, root)).candidates["feature:" + id]?.feature;
      if (feature) feature.resultAt = Math.max(feature.resultAt ?? at, at);
    }).catch(error => console.warn("Feedback usage recording failed", error)),
    settings: async () => (await harness().snapshot(Preferences, root, context))!,
  };
}
