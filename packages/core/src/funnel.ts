import type { Notification } from "./notifications.ts";

export function funnel(notifications: readonly Notification[], timeZone: string, days = 7,
  options: { at?: number; feishu?: boolean } = {}) {
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError("days must be a positive integer");
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const empty = (date: string) => ({ date, triggered: 0, passed: 0, pushed: 0, read: 0, useful: 0, useless: 0, digests: 0, reminders: 0 });
  const byDate = new Map<string, ReturnType<typeof empty>>();
  // A standalone snapshot ends on its latest notification. Live callers supply their clock and delivery mode.
  const at = options.at ?? notifications.reduce((latest, item) => Math.max(latest, item.at), -Infinity);
  const feishu = options.feishu ?? notifications.some(item => item.pushedAt !== undefined);
  if (Number.isFinite(at)) {
    const date = new Date(format.format(at) + "T00:00:00Z");
    date.setUTCDate(date.getUTCDate() - days + 1);
    for (let i = 0; i < days; i++) {
      const key = date.toISOString().slice(0, 10);
      byDate.set(key, empty(key));
      date.setUTCDate(date.getUTCDate() + 1);
    }
  }
  let useful = 0, useless = 0;
  for (const item of notifications) {
    const day = byDate.get(format.format(item.at));
    if (!day) continue;
    if (item.kind === "digest") { day.digests++; continue; }
    if (item.kind === "reminder") { day.reminders++; continue; }
    day.triggered++;
    if (!item.filtered) day.passed++;
    if (item.level === "now" && (!feishu || item.pushedAt !== undefined)) day.pushed++;
    if (item.status === "read") day.read++;
    if (item.feedback === "useful") { day.useful++; useful++; }
    if (item.feedback === "useless") { day.useless++; useless++; }
  }
  return { timeZone, days: [...byDate.values()], precision: useful + useless ? useful / (useful + useless) : null };
}
