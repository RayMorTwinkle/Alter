import { Audit, Requests, Reviews, shadowAgreement, type Review } from "./broker.ts";
import { calendarTime } from "./calendar-time.ts";
import { funnel } from "./funnel.ts";
import { Notifications } from "./notifications.ts";
import type { AlterApp } from "./observe.ts";
import { context, type Cursor } from "./runtime.ts";
import { Ledger, Tasks, type TaskRecord } from "./state.ts";
import { splitUsage, totalInput, usageLines, usageRole, type UsageLine } from "./usage.ts";
import { Wakes, type Wake } from "./wake.ts";

export type StatsRange = "day" | "7d" | "30d" | "all";

function emptyUsage() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0,
    costUsd: null as number | null, cacheHitRate: null as number | null, errors: 0, aborted: 0, fallbacks: 0, retries: 0 };
}

type Counts = Omit<UsageLine, "at" | "model" | "attempt" | "latencyMs">;
function addUsage(group: ReturnType<typeof emptyUsage>, line: Counts) {
  const input = totalInput(line);
  const previousInput = group.input + group.cacheRead + group.cacheWrite;
  const unknownCache = (previousInput > 0 && group.cacheHitRate === null) || (input > 0 && line.input === undefined);
  const cost = line.costUsd ?? null;
  group.costUsd = cost === null || (group.calls > 0 && group.costUsd === null) ? null : (group.costUsd ?? 0) + cost;
  group.calls++;
  group.input += line.input ?? input;
  group.cacheRead += line.cacheRead ?? 0;
  group.cacheWrite += line.cacheWrite ?? 0;
  group.output += line.outputTokens ?? 0;
  group.tokens += input + (line.outputTokens ?? 0);
  group.cacheHitRate = unknownCache || !(previousInput + input) ? null : group.cacheRead / (previousInput + input);
  if (line.errorKind === "aborted") group.aborted++;
  else if (line.outcome === "error") group.errors++;
  if (line.fallback ?? line.fallbackFrom !== undefined) group.fallbacks++;
  group.retries += line.retry ?? 0;
}

function bucket<T>(groups: Map<string, T>, key: string, create: () => T) {
  let value = groups.get(key);
  if (value === undefined) {
    value = create();
    groups.set(key, value);
  }
  return value;
}

function percentiles() {
  const counts = new Map<number, number>();
  let samples = 0;
  return {
    add(ms?: number) {
      if (ms === undefined || !Number.isFinite(ms) || ms < 0) return;
      counts.set(ms, (counts.get(ms) ?? 0) + 1);
      samples++;
    },
    result() {
      let rank = 0;
      let p50Ms: number | null = null, p95Ms: number | null = null;
      for (const ms of [...counts.keys()].sort((a, b) => a - b)) {
        rank += counts.get(ms)!;
        if (rank >= Math.ceil(samples * 0.5)) p50Ms ??= ms;
        if (rank >= Math.ceil(samples * 0.95)) { p95Ms = ms; break; }
      }
      return { samples, p50Ms, p95Ms };
    },
  };
}

async function* recordedResponses(app: AlterApp, taskId: string, task: TaskRecord) {
  const first = await app.main.commit(async tx => (await tx.submissionByRequest(task.conversationId, `brief-${taskId}`))?.entry, context);
  if (first === undefined) return;
  const child = await app.harness.conversation(task.conversationId, context);
  if (!child) return;
  let cursor: Cursor | undefined;
  do {
    const page = await child.entries({ minEntryId: first, maxEntryId: task.lastEntry }, 64, cursor, context);
    for (const entry of page.items) {
      for (const msg of entry.model ?? []) if (msg.role === "assistant") yield msg;
    }
    cursor = page.next;
  } while (cursor);
}

function reviewStats(reviews: Record<string, Review>, start: number, end: number) {
  const within = (at?: number) => at === undefined ? start === -Infinity : at >= start && at <= end;
  const userDecisions = { once: 0, statement: 0, "task-full": 0, deny: 0 };
  const judgments = { inScope: 0, outOfScope: 0 };
  const paired: Review[] = [];
  const counts = { user: 0, judge: 0, timeout: 0 };
  let expired = 0;
  for (const review of Object.values(reviews)) {
    if (review.user && within(review.userAt)) {
      userDecisions[review.user]++;
      counts.user++;
    }
    if (review.judgment && within(review.judgedAt)) judgments[review.judgment.inScope ? "inScope" : "outOfScope"]++;
    if (review.judgeAllowedAt !== undefined && within(review.judgeAllowedAt)) counts.judge++;
    if (review.timeoutAt !== undefined && within(review.timeoutAt)) counts.timeout++;
    if (review.ended === "expired" && within(review.expiredAt)) expired++;
    const pairedAt = Math.max(review.userAt ?? -Infinity, review.judgedAt ?? -Infinity);
    if (review.user && review.judgment && within(pairedAt)) paired.push(review);
  }
  const shadow = shadowAgreement(paired);
  return { userDecisions, judgments, shadow, shadowAgreementRate: shadow.agreementRate, expired, timeouts: counts.timeout,
    byApprover: (["user", "judge", "timeout"] as const).map(approver => ({ approver, count: counts[approver] })) };
}

export async function stats(range: StatsRange, timeZone: string, { app, dir, feishu = false }: {
  app: AlterApp; dir: string; feishu?: boolean;
}) {
  const at = app.now();
  const days = range === "day" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : undefined;
  const start = days ? calendarTime(timeZone).midnight(at, 1 - days) : -Infinity;
  const includes = (ms: number) => ms >= start && ms <= at;
  const [tasks, ledger, audit, requests, wakes, notifications, reviews] = await Promise.all([
    app.harness.snapshot(Tasks, app.main.id, context), app.harness.snapshot(Ledger, app.main.id, context),
    app.harness.snapshot(Audit, app.main.id, context), app.harness.snapshot(Requests, app.main.id, context),
    app.harness.snapshot(Wakes, app.main.id, context), app.harness.snapshot(Notifications, app.main.id, context),
    app.harness.snapshot(Reviews, app.main.id, context),
  ]);
  const dates = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  let earliest = at;
  const daily = new Map<string, ReturnType<typeof emptyDay>>();
  function emptyDay() { return { usage: emptyUsage(), tasks: 0, succeeded: 0, wakes: 0 }; }
  function day(ms: number) {
    earliest = Math.min(earliest, ms);
    return bucket(daily, dates.format(ms), emptyDay);
  }

  const results = new Map(ledger?.entries.map(entry => [entry.taskId, entry]));
  const entries = audit?.entries ?? [];
  type AuditEntry = (typeof entries)[number];
  function taskStats(taskId: string, task: TaskRecord) {
    const result = task.status === "completed" || task.status === "cancelled" ? results.get(taskId) : undefined;
    const ended = task.endedAt ?? result?.at ?? (task.status === "running" ? at : undefined);
    return { taskId, status: task.status, createdAt: task.createdAt, continuedFrom: task.continuedFrom ?? null,
      wakeId: task.wakeId ?? null, thinking: task.thinking, models: new Set<string>(), usage: emptyUsage(),
      durationMs: ended === undefined || !task.createdAt ? null : Math.max(0, ended - task.createdAt),
      usageSource: "none" as "ledger" | "transcript" | "none", rounds: 0, tools: new Map<string, number>(),
      approvals: [] as AuditEntry[], reviews: [] as (Omit<Review, "note" | "itemCount"> & { requestId: string })[],
      result: result?.summary ?? task.failure ?? null };
  }
  const taskDetails = new Map<string, ReturnType<typeof taskStats>>();
  const dispatched = new Map<string, number>();
  let completed = 0, terminal = 0;
  for (const [id, task] of Object.entries(tasks?.byId ?? {})) {
    if (task.createdAt > at) continue;
    if (task.wakeId) dispatched.set(task.wakeId, (dispatched.get(task.wakeId) ?? 0) + 1);
    if (!includes(task.createdAt)) continue;
    taskDetails.set(id, taskStats(id, task));
    if (task.status !== "running") terminal++;
    if (task.status === "completed") completed++;
    if (task.createdAt) {
      const cohort = day(task.createdAt);
      cohort.tasks++;
      if (task.status === "completed") cohort.succeeded++;
    }
  }

  function wakeStats(wake: Wake) {
    return { ...wake, usage: emptyUsage(), dispatchedTasks: dispatched.get(wake.wakeId) ?? 0 };
  }
  const wakeDetails = new Map<string, ReturnType<typeof wakeStats>>();
  function includeWake(wake: Wake) {
    if (!includes(wake.wakeAt)) return;
    return bucket(wakeDetails, wake.wakeId, () => { day(wake.wakeAt).wakes++; return wakeStats(wake); });
  }
  for (const wake of Object.values(wakes?.byId ?? {})) includeWake(wake);

  const total = emptyUsage();
  const roles = new Map<string, typeof total>(), models = new Map<string, typeof total>();
  const latency = percentiles(), firstToken = percentiles();
  for await (const line of usageLines(dir)) {
    const ms = Date.parse(line.at);
    if (!Number.isFinite(ms) || ms > at) continue;
    const role = usageRole(line);
    if (includes(ms)) {
      addUsage(total, line);
      addUsage(bucket(roles, role, emptyUsage), line);
      addUsage(bucket(models, line.model, emptyUsage), line);
      addUsage(day(ms).usage, line);
      latency.add(line.latencyMs);
      firstToken.add(line.firstTokenMs);
    }
    const task = line.taskId && taskDetails.get(line.taskId);
    if (task) {
      task.usageSource = "ledger";
      addUsage(task.usage, line);
      task.models.add(line.model);
      if (role === "task" || role === "goal") {
        if (line.attempt === 1) task.rounds++;
        for (const tool of line.tools ?? []) task.tools.set(tool, (task.tools.get(tool) ?? 0) + 1);
      }
    }
    if (role === "main" && line.wakeId) {
      const wake = wakeDetails.get(line.wakeId) ?? includeWake({ wakeId: line.wakeId, wakeSource: line.wakeSource ?? "unknown", wakeAt: line.wakeAt ?? ms });
      if (wake) addUsage(wake.usage, line);
    }
  }

  for (const task of taskDetails.values()) {
    if (task.usage.calls) continue;
    for await (const msg of recordedResponses(app, task.taskId, tasks!.byId[task.taskId]!)) {
      task.usageSource = "transcript";
      task.rounds++;
      task.models.add(msg.model);
      for (const part of msg.content) {
        if (part.type === "toolCall") task.tools.set(part.name, (task.tools.get(part.name) ?? 0) + 1);
      }
      const failed = msg.stopReason === "error" || msg.stopReason === "aborted";
      addUsage(task.usage, { outcome: failed ? "error" : "ok", errorKind: failed ? msg.stopReason : undefined, ...splitUsage(msg.usage) });
    }
  }

  const decisions = { park: 0, allow: 0, deny: 0 };
  for (const entry of entries) {
    if (entry.at > at) continue;
    taskDetails.get(entry.taskId)?.approvals.push(entry);
    if (includes(entry.at)) { decisions[entry.decision]++; earliest = Math.min(earliest, entry.at); }
  }
  const approvalReviews = reviews?.byId ?? {};
  for (const [requestId, { note, itemCount, ...review }] of Object.entries(approvalReviews)) {
    if (review.taskId) taskDetails.get(review.taskId)?.reviews.push({ requestId, ...review });
    for (const date of [review.userAt, review.judgedAt, review.judgeAllowedAt, review.timeoutAt, review.expiredAt]) {
      if (date !== undefined && includes(date)) earliest = Math.min(date, earliest);
    }
  }
  const pending = Object.values(requests?.pending ?? {}).filter(req => !req.checking).map(({ id, taskId, audience, tool, expiresAt }) => ({ id, taskId, audience, tool, expiresAt }));
  const taskRows = [...taskDetails.values()].map(task => ({ ...task, models: [...task.models], tools: Object.fromEntries(task.tools) }));
  const wakeRows = [...wakeDetails.values()].sort((a, b) => b.wakeAt - a.wakeAt);
  const sources = new Map<string, number>();
  for (const { wakeSource } of wakeRows) sources.set(wakeSource, (sources.get(wakeSource) ?? 0) + 1);

  const notices = (notifications?.entries ?? []).filter(item => includes(item.at));
  for (const item of notices) earliest = Math.min(earliest, item.at);
  const calendarDays = days ?? 1 + (Date.parse(dates.format(at)) - Date.parse(dates.format(earliest))) / 86_400_000;
  const proactive = funnel(notices, timeZone, calendarDays, { at, feishu });
  return { range, timeZone, at, total, byRole: [...roles].map(([role, usage]) => ({ role, ...usage })),
    byModel: [...models].map(([model, usage]) => ({ model, ...usage })),
    tasks: { count: taskRows.length, completed, terminal, successRate: terminal ? completed / terminal : null,
      items: taskRows.sort((a, b) => b.createdAt - a.createdAt) },
    wakes: { count: wakeRows.length, bySource: Object.fromEntries(sources), items: wakeRows },
    approvals: { decisions, pending, ...reviewStats(approvalReviews, start, at) },
    funnel: proactive, watchWakeAccuracy: null,
    latency: { firstToken: firstToken.result(), total: latency.result() },
    topTasks: taskRows.flatMap(task => task.usage.costUsd === null ? [] : [{ taskId: task.taskId, costUsd: task.usage.costUsd }])
      .sort((a, b) => b.costUsd - a.costUsd || a.taskId.localeCompare(b.taskId)).slice(0, 10),
    daily: proactive.days.map(({ date }) => ({ date, ...(daily.get(date) ?? emptyDay()) })),
  };
}
