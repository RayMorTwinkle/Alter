import { randomUUID } from "node:crypto";
import { Audit, Reviews } from "./broker.ts";
import { feedbackPaused, Preferences, Interaction, triageScope, type PreferenceKey, type PreferenceValue } from "./feedback-settings.ts";
import { heartbeatResponse } from "./heartbeat-state.ts";
import { recentRuns } from "./heartbeat-runs.ts";
import { MemoryInbox } from "./memory-inbox.ts";
import type { MemoryEntry } from "./memory-store.ts";
import { reviewQuestions, type FeedbackCall } from "./feedback-model.ts";
import { Wakes } from "./wake.ts";
import { Notifications } from "./notifications.ts";
import { conversationDoc, ROOT_CONVERSATION_ID as root, type Tx } from "./runtime.ts";

export const day = 86_400_000;
export type FeedbackQuestion = { id: string; prompt: string; options: string[]; allowOther: boolean; multi: boolean; why: string };
export type Source = "mismatch" | "silent-proactive" | "feature" | "style";
export type Outlet = "report" | "checkin";
export type Effect = { kind: "memory"; entryId: string } |
  { kind: "param"; key: PreferenceKey; mapping: Record<string, PreferenceValue>; scope?: string } |
  { kind: "metric"; name: string };
export type Candidate = FeedbackQuestion & { source: Source; effect: Effect; uncertainty: number; retired?: true;
  feature?: { key: string; name: string; installedAt: number; resultAt?: number }; lastAnsweredAt?: number; createdAt: number; cooldownUntil: number; asked: number; answered: number; skipped: number };
export type Answer = { options: string[]; other?: string };
export type Issued = FeedbackQuestion & { candidateId: string; source: Source; effect: Effect; outlet: Outlet; batch: string;
  optionMap?: Record<string, string>; askedAt: number; status: "pending" | "applying" | "answered" | "skipped" | "expired"; at?: number; answer?: Answer; moreUsed?: true; changeIds: string[] };
export type Change = { id: string; issueId: string; at: number; kind: Effect["kind"] | "undo"; key: string;
  before: PreferenceValue | string[] | null; after: PreferenceValue | string[] | null;
  memoryChangeId?: string; memoryAction?: "confirm" | "correct" | "delete" | "add" | "modify" | "restore"; undoneBy?: string; undoOf?: string };
export type Bank = { candidates: Record<string, Candidate>; issues: Record<string, Issued>; changes: Record<string, Change>;
  runtimeId?: string; startedAt?: number; lastCheckin?: number; visits: string[] };
export const Feedback = conversationDoc<Bank>("feedback", () => ({ candidates: {}, issues: {}, changes: {}, visits: [] }));
export class FeedbackError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Seed = Omit<Candidate, "createdAt" | "asked" | "answered" | "skipped" | "cooldownUntil" | "uncertainty">;
const nonempty = (v: unknown): v is string => typeof v === "string" && !!v.trim();
function validEffect(e: Effect, q: Seed) {
  if (!e || typeof e !== "object") return false;
  if (e.kind === "metric") return nonempty(e.name);
  if (e.kind !== "param" || q.multi || !e.mapping || typeof e.mapping !== "object") return false;
  if (e.scope && ["__proto__", "prototype", "constructor"].includes(e.scope)) return false;
  if (q.allowOther && e.key !== "replyLength" && e.key !== "permissionNotes") return false;
  return q.options.every(o => {
    if (!Object.hasOwn(e.mapping, o)) return false;
    const v = e.mapping[o];
    switch (e.key) {
      case "heartbeatBias": case "reportFrequency": return typeof v === "number" && Number.isFinite(v) && v > 0;
      case "triagePreference": return nonempty(e.scope) && (v === "now" || v === "digest" || v === "silent");
      case "permissionNotes": return nonempty(e.scope) && nonempty(v);
      case "replyLength": return nonempty(v);
      default: return false;
    }
  });
}
export function putQuestion(bank: Bank, q: Seed, at: number, uncertainty = 1) {
  if (["__proto__", "prototype", "constructor"].includes(q.id) || !isFeedbackSource(q.source) ||
      typeof q.allowOther !== "boolean" || typeof q.multi !== "boolean" || !Number.isFinite(uncertainty) || uncertainty <= 0 ||
      !nonempty(q.why) || !nonempty(q.prompt) || !nonempty(q.id) || !q.options.length || !q.options.every(nonempty) ||
      new Set(q.options).size !== q.options.length || !validEffect(q.effect, q)) throw new FeedbackError(400, "Invalid feedback question or effect");
  const prior = Object.hasOwn(bank.candidates, q.id) ? bank.candidates[q.id] : undefined;
  if (prior) { prior.uncertainty = uncertainty; delete prior.retired; return prior; }
  bank.candidates[q.id] = { ...q, uncertainty, createdAt: at, cooldownUntil: 0, asked: 0, skipped: 0, answered: 0 };
  return bank.candidates[q.id]!;
}
export function featureQuestion(bank: Bank, id: string, name: string, at: number) {
  const label = [...name].length > 24 ? [...name].slice(0, 23).join("") + "…" : name;
  const prompt = `用过「${label}」后，你觉得哪里有帮助？`;
  const options = ["省了时间", "少漏了事情", "暂时没帮上忙"];
  const q = putQuestion(bank, { id: "feature:" + id, source: "feature", prompt,
    why: "了解你用过的新功能是否有帮助，用于本机每周产品反馈。", options, allowOther: true, multi: true,
    effect: { kind: "metric", name: "feature:" + id } }, at);
  q.feature = { ...q.feature, key: id, name, installedAt: at };
  q.prompt = prompt;
  q.options = options;
}
export function seedQuestions(bank: Bank, at: number) {
  bank.startedAt ??= at;
  featureQuestion(bank, "feedback-v1", "回访反馈", Date.UTC(2026, 10, 23));
  putQuestion(bank, { id: "style:length", source: "style", prompt: "你希望我的回复有多详细？", why: "会更新回复长度设置和偏好记忆。",
    options: ["简短", "适中", "详细"], allowOther: true, multi: false,
    effect: { kind: "param", key: "replyLength", mapping: { 简短: "简短", 适中: "适中", 详细: "详细" } } }, at);
  putQuestion(bank, { id: "style:report", source: "style", prompt: "你希望多久收到一次近况报告？", why: "会调整下次近况报告的间隔。",
    options: ["频繁一些", "默认频率", "少一些"], allowOther: false, multi: false,
    effect: { kind: "param", key: "reportFrequency", mapping: { 频繁一些: 0.5, 默认频率: 1, 少一些: 2 } } }, at);
  putQuestion(bank, { id: "style:satisfaction", source: "style", prompt: "这段时间你对 Alter 的帮助满意吗？", why: "用于跟踪每周满意度。",
    options: ["不满意", "一般", "满意"], allowOther: true, multi: false, effect: { kind: "metric", name: "satisfaction" } }, at);
  putQuestion(bank, { id: "style:usefulness", source: "style", prompt: "最近的主动提醒有帮助吗？", why: "用于跟踪主动产出的有用率。",
    options: ["有用", "没用", "还没看"], allowOther: true, multi: false, effect: { kind: "metric", name: "proactive-usefulness" } }, at);
}
export function knownReplyLength(entries: MemoryEntry[]) {
  return entries.some(e =>
    /(?:回复|回答|答复|回话).{0,18}(?:简短|简洁|精简|简练|简明|精炼|详细|篇幅|长短|字数|少说)|(?:简短|简洁|详细).{0,10}(?:回复|回答|答复)/u.test(e.title + " " + e.body));
}
export function fixedMetric(q: Candidate | Issued) {
  return q.effect.kind === "metric" && ["satisfaction", "proactive-usefulness"].includes(q.effect.name);
}
export function originalOption(i: Issued, option?: string) { return option && (i.optionMap?.[option] ?? option); }
type Editor = { call: FeedbackCall; now: () => number; memory: () => { index: string; entries: MemoryEntry[] } };
// The report API receives only a Tx. Resolve the owning app's model, clock and memory independently per bank.
export const feedbackEditors = new Map<string, Editor>();
async function ruleQuestions(tx: Tx, bank: Bank, at: number) {
  const active = new Set<string>();
  const reviews = Object.values((await tx.doc(Reviews, root)).byId);
  const conflicts = new Map<string, number>();
  for (const r of reviews) if (r.tool && r.user && r.judgment && r.judgment.inScope !== (r.user !== "deny") &&
    Math.max(r.judgedAt ?? 0, r.userAt ?? 0) > (bank.candidates["approval:" + r.tool]?.lastAnsweredAt ?? -Infinity)) {
    conflicts.set(r.tool, (conflicts.get(r.tool) ?? 0) + 1);
  }
  for (const [tool, n] of conflicts) {
    active.add("approval:" + tool);
    const options = ["核对操作对象", "核对用途", "不确定时询问我"];
    putQuestion(bank, { id: "approval:" + tool, source: "mismatch", prompt: "审批 " + tool + " 时，希望我特别注意什么？",
      why: "审批模型的判断与你的决定不一致。答案会追加到这类操作的权限说明。", options, allowOther: true, multi: false,
      effect: { kind: "param", key: "permissionNotes", scope: tool, mapping: Object.fromEntries(options.map(o => [o, o])) } }, at, 1 + Math.min(n, 5) / 5);
  }
  const votes = new Map<string, { label: string; no: number; yes: number }>();
  for (const n of (await tx.doc(Notifications, root)).entries) {
    if (n.kind !== "event" || !n.feedback) continue;
    const scope = triageScope(n.source, n.category);
    if (n.at <= (bank.candidates["triage:" + scope]?.lastAnsweredAt ?? -Infinity)) continue;
    const counts = votes.get(scope) ?? { label: [n.source, n.category].filter(Boolean).join(" · "), no: 0, yes: 0 };
    if (n.feedback === "useless") counts.no++;
    else counts.yes++;
    votes.set(scope, counts);
  }
  for (const [scope, { label, no, yes }] of votes) if (no >= 2 && no >= yes) {
    active.add("triage:" + scope);
    putQuestion(bank, { id: "triage:" + scope, source: "mismatch", prompt: label + " 的消息以后怎样提醒你？",
      why: "这类消息多次被标为没用。答案会调整该类消息的分诊级别。", options: ["立即提醒", "放入摘要", "静默"], multi: false, allowOther: false,
      effect: { kind: "param", key: "triagePreference", scope, mapping: { 立即提醒: "now", 放入摘要: "digest", 静默: "silent" } } }, at, 1 + no / (yes + no));
  }
  for (const run of await recentRuns(tx)) {
    if (run.finishedAt === null || run.finishedAt <= (bank.candidates["heartbeat:bias"]?.lastAnsweredAt ?? -Infinity) || at - run.finishedAt < day || at - run.finishedAt > 14 * day || run.feedback ||
        !(run.notified || run.actions.some(a => a.tool === "dispatch_task")) || await heartbeatResponse(tx, run.id)) continue;
    active.add("heartbeat:bias");
    putQuestion(bank, { id: "heartbeat:bias", source: "silent-proactive", prompt: "最近的巡检产出没有收到回应，你希望我多久主动找一次？",
      why: "会调整自适应巡检的间隔。", options: ["更频繁", "默认频率", "少一些"], multi: false, allowOther: false,
      effect: { kind: "param", key: "heartbeatBias", mapping: { 更频繁: 0.5, 默认频率: 1, 少一些: 2 } } }, at, 1.5);
    break;
  }
  for (const q of Object.values(bank.candidates)) if ((q.source === "mismatch" || q.source === "silent-proactive") && !active.has(q.id)) q.retired = true;
}
export async function lastInteraction(tx: Tx) {
  return Math.max((await tx.doc(Interaction, root)).at ?? -Infinity, (await tx.doc(MemoryInbox, root)).lastUserAt ?? -Infinity);
}
const sourceWeight = { mismatch: 3, "silent-proactive": 2, feature: 1.5, style: 1 };
export function isFeedbackSource(source: string): source is Source { return Object.hasOwn(sourceWeight, source); }
export async function pickQuestions(tx: Tx, options: { outlet: Outlet; limit: number }): Promise<FeedbackQuestion[]> {
  const bank = await tx.doc(Feedback, root);
  return issueQuestions(tx, options, feedbackEditors.get(bank.runtimeId ?? "")?.now() ?? Date.now());
}
export async function issueQuestions(tx: Tx, { outlet, limit, minimum = 1, batch = randomUUID() }:
  { outlet: Outlet; limit: number; minimum?: number; batch?: string }, at: number): Promise<FeedbackQuestion[]> {
  const bank = await tx.doc(Feedback, root);
  if (feedbackPaused || at - await lastInteraction(tx) >= 7 * day) return [];
  await ruleQuestions(tx, bank, at);
  const editor = feedbackEditors.get(bank.runtimeId ?? "");
  const memory = editor?.memory();
  const counts = new Map<string, { asked: number; skipped: number }>();
  const type = (q: Candidate) => q.source + "/" + (q.multi ? "multi" : "single");
  for (const q of Object.values(bank.candidates)) {
    const c = counts.get(type(q)) ?? { asked: 0, skipped: 0 };
    c.asked += q.asked; c.skipped += q.skipped; counts.set(type(q), c);
  }
  const score = (q: Candidate) => {
    const c = counts.get(type(q))!;
    return sourceWeight[q.source] * ({ memory: 3, param: 2, metric: 1 }[q.effect.kind]) * q.uncertainty /
      (1 + 4 * c.skipped / (1 + c.asked) + q.skipped / (1 + q.answered));
  };
  const prefs = await tx.doc(Preferences, root);
  const knownLength = prefs.replyLength !== null || knownReplyLength(memory?.entries ?? []);
  const audit = (await tx.doc(Audit, root)).entries;
  const recentCalls = new Map<string, number[]>();
  const weekCalls = new Map<string, number>();
  for (const event of audit) {
    if (event.at > at || event.at < at - 14 * day || event.decision !== "allow") continue;
    const times = recentCalls.get(event.capability) ?? [];
    times.push(event.at);
    recentCalls.set(event.capability, times);
    if (event.at >= at - 7 * day) weekCalls.set(event.capability, (weekCalls.get(event.capability) ?? 0) + 1);
  }
  const issues = Object.values(bank.issues);
  const currentBatch = issues.filter(i => i.batch === batch);
  let featureUsed = currentBatch.some(i => i.source === "feature");
  let metricUsed = currentBatch.some(fixedMetric);
  function usedFeature(q: Candidate) {
    const f = q.feature;
    if (!f || at < f.installedAt || at - f.installedAt > 30 * day) return false;
    const since = Math.max(f.installedAt, at - 14 * day);
    if (f.resultAt !== undefined && f.resultAt >= since && f.resultAt <= at) return true;
    if (f.key === "feedback-v1") {
      const uses = issues.filter(i => i.status === "answered" && i.at! >= since && i.at! <= at);
      return uses.length >= 3 || uses.some(i => i.changeIds.length);
    }
    return (recentCalls.get(f.key) ?? []).filter(t => t >= since).length >= 3;
  }
  const ranked = Object.values(bank.candidates).filter(q => !q.retired && q.cooldownUntil <= at &&
    !(q.id === "style:length" && knownLength) && (q.source !== "feature" || (!q.answered && usedFeature(q))))
    .sort((a, b) => score(b) - score(a) || a.asked - b.asked || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const limitOut = Math.max(0, Math.min(outlet === "report" ? 2 : 5, Math.floor(limit)));
  if (!limitOut || limitOut < minimum) return [];
  const candidates: Candidate[] = [];
  let features = 0, metrics = 0;
  for (const q of ranked) {
    if (q.source === "feature") {
      if (featureUsed || features === 2) continue;
      features++;
    }
    if (fixedMetric(q)) {
      if (metricUsed || metrics === 2) continue;
      metrics++;
    }
    candidates.push(q);
    if (candidates.length >= 2 * limitOut + 2) break;
  }
  if (candidates.length - Math.max(0, features - 1) - Math.max(0, metrics - 1) < minimum) return [];
  const wakes = Object.values((await tx.doc(Wakes, root)).byId).filter(w => w.wakeAt >= at - 7 * day && w.wakeAt <= at);
  const usage = { days: 7, userTurns: wakes.filter(w => w.wakeSource.startsWith("user-")).length,
    toolCalls: Object.fromEntries(weekCalls), feedbackAnswered: issues.filter(i => i.status === "answered" && i.at! >= at - 7 * day && i.at! <= at).length };
  const edits = editor && await reviewQuestions(editor.call, candidates, memory!.index.slice(0, 12000), usage);
  const selected = candidates.filter(q => {
    if (edits?.get(q.id) === "drop") return false;
    if (q.source === "feature") { if (featureUsed) return false; featureUsed = true; }
    if (fixedMetric(q)) { if (metricUsed) return false; metricUsed = true; }
    return true;
  }).slice(0, limitOut);
  if (selected.length < minimum) return [];
  return selected.map(q => {
    for (const prior of issues) if (prior.candidateId === q.id && prior.status === "pending") prior.status = "expired";
    q.asked++;
    q.cooldownUntil = at + 7 * day;
    const edit = edits?.get(q.id);
    const wording = edit && edit !== "drop" ? edit : undefined;
    const question = { id: randomUUID(), prompt: wording?.prompt ?? q.prompt, options: wording?.options ?? [...q.options], allowOther: q.allowOther, multi: q.multi, why: q.why };
    const original = q.effect;
    const effect = original.kind === "param" && wording ? { ...original,
      mapping: Object.fromEntries(question.options.map(o => [o, original.mapping[wording.mapping[o]!]!])) } : q.effect;
    bank.issues[question.id] = { ...question, candidateId: q.id, effect, source: q.source, outlet, batch, askedAt: at,
      ...(wording && { optionMap: wording.mapping }), status: "pending", changeIds: [] };
    return question;
  });
}
