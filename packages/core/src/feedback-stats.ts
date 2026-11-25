import { Reviews } from "./broker.ts";
import { calendarTime } from "./calendar-time.ts";
import { day, Feedback, originalOption, type Issued } from "./feedback.ts";
import { FeedbackOutcomes, triageScope } from "./feedback-settings.ts";
import { heartbeatAdopted } from "./heartbeat-state.ts";
import { recentRuns } from "./heartbeat-runs.ts";
import { Notifications } from "./notifications.ts";
import { ROOT_CONVERSATION_ID as root, type Tx } from "./runtime.ts";

function counts(rows: Issued[]) {
  const asked = rows.length;
  const skipped = rows.filter(i => i.status === "skipped").length;
  const answered = rows.filter(i => i.status === "answered").length;
  return { asked, answered, skipped, answerRate: asked ? answered / asked : null, skipRate: asked ? skipped / asked : null };
}
type Sample = { at: number; value: number };
function mean(rows: Sample[]) { return rows.length ? rows.reduce((sum, s) => sum + s.value, 0) / rows.length : null; }
export async function feedbackStats(tx: Tx, at: number, zone: string) {
  const bank = await tx.doc(Feedback, root);
  const issues = Object.values(bank.issues);
  const changes = Object.values(bank.changes).filter(c => c.kind !== "undo");
  const scores = { 不满意: 1, 一般: 2, 满意: 3 } as Record<string, number>;
  function metric(name: string, values: Record<string, number>) {
    return changes.flatMap(c => {
      const i = bank.issues[c.issueId]!;
      const option = originalOption(i, i.answer?.options[0]);
      return c.kind === "metric" && c.key === name && !c.undoneBy && option && Object.hasOwn(values, option)
        ? [{ at: c.at, value: values[option]! }] : [];
    }).sort((a, b) => a.at - b.at);
  }
  const satisfaction = metric("satisfaction", scores);
  const usefulness = metric("proactive-usefulness", { 有用: 1, 没用: 0 });
  const outcomes = await tx.doc(FeedbackOutcomes, root);
  const inspections: Sample[] = Object.values(outcomes.inspections);
  for (const run of await recentRuns(tx)) if (!outcomes.inspections[run.id] && run.status === "ran" && run.finishedAt !== null) {
    inspections.push({ at: run.at, value: Number(await heartbeatAdopted(tx, run.id)) });
  }
  const reviews = Object.values((await tx.doc(Reviews, root)).byId);
  const notices = (await tx.doc(Notifications, root)).entries;
  const impacts = changes.filter(c => c.kind !== "metric").map(c => {
    const e = bank.issues[c.issueId]!.effect;
    let series = satisfaction, metric = "satisfaction";
    if (e.kind === "param" && e.key === "heartbeatBias") { series = inspections; metric = "heartbeatAdoption"; }
    if (e.kind === "param" && e.key === "triagePreference") {
      series = Object.values(outcomes.notifications).filter(n => n.source === e.scope);
      series.push(...notices.flatMap(n => !outcomes.notifications[n.id] && n.kind === "event" && triageScope(n.source, n.category) === e.scope && n.feedback ? [{ at: n.at, value: Number(n.feedback === "useful") }] : []));
      metric = "notificationUsefulness";
    }
    if (e.kind === "param" && e.key === "permissionNotes") {
      series = reviews.flatMap(r => r.judgment && r.user && r.tool === e.scope && r.userAt !== undefined && r.judgedAt !== undefined ?
        [{ at: Math.max(r.userAt, r.judgedAt), value: Number((r.user !== "deny") === r.judgment.inScope) }] : []);
      metric = "approvalAgreement";
    }
    const next = changes.find(other => other.kind === c.kind && other.key === c.key && other.at > c.at);
    const end = Math.min(next?.at ?? Infinity, c.undoneBy ? bank.changes[c.undoneBy]!.at : Infinity);
    const before = series.filter(s => s.at >= c.at - 7 * day && s.at < c.at);
    const after = series.filter(s => s.at > c.at && s.at <= at && s.at <= c.at + 7 * day && s.at < end);
    return { changeId: c.id, metric, before: mean(before), beforeSamples: before.length, after: mean(after), afterSamples: after.length };
  });
  const time = calendarTime(zone);
  const monday = (ms: number) => {
    const date = time.describe(ms).iso.slice(0, 10);
    const weekday = new Date(date + "T00:00:00Z").getUTCDay();
    return time.describe(time.midnight(ms, -((weekday + 6) % 7))).iso.slice(0, 10);
  };
  const weeks = new Set([...issues.map(i => monday(i.askedAt)), ...changes.map(c => monday(c.at))]);
  const weekly = [...weeks].sort().map(week => ({
    week, ...counts(issues.filter(i => monday(i.askedAt) === week)), changes: changes.filter(c => monday(c.at) === week).length,
    satisfaction: mean(satisfaction.filter(s => monday(s.at) === week)), usefulness: mean(usefulness.filter(s => monday(s.at) === week)),
    productFeedback: changes.filter(c => c.kind === "metric" && c.key.startsWith("feature:") && !c.undoneBy && monday(c.at) === week)
      .map(c => ({ feature: c.key.slice(8), answer: Array.isArray(c.after) ? [...c.after] : c.after })),
  }));
  const bySource = Object.fromEntries(["mismatch", "silent-proactive", "feature", "style"].map(s => [s, counts(issues.filter(i => i.source === s))]));
  return { ...counts(issues), bySource, byType: { single: counts(issues.filter(i => !i.multi)), multi: counts(issues.filter(i => i.multi)) },
    changeCount: changes.length, satisfaction, usefulness, impacts, weekly };
}
