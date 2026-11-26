import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as say, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it, vi } from "vitest";
import { createCalendarPlugin } from "../../plugin-calendar/src/index.ts";
import { answerUserPermission, Requests } from "../src/broker.ts";
import { ScheduledTasks } from "../src/scheduled-tasks.ts";
import { Notifications } from "../src/notifications.ts";
import { openAlter } from "../src/main.ts";
import { observeSurface } from "../src/observe.ts";
import { context, openNodeSqliteStorage, type ToolRegistration } from "../src/runtime.ts";
import { Ledger, Tasks } from "../src/state.ts";
import { stats } from "../src/stats.ts";
import { budgetExhausted, readUsage } from "../src/usage.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { try { while (cleanup.length) await cleanup.pop()!(); } finally { vi.unstubAllEnvs(); } });
const minute = 60_000;
const initial = Date.parse("2026-11-27T15:58:00Z"); // Friday 23:58 in Taipei.

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "alter-scheduled-task-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const clock = { at: initial };
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }], tokensPerSecond: Infinity });
  models.setProvider(faux.provider);
  const calendar = createCalendarPlugin({ dataDir: dir, timeZone: "Asia/Taipei", now: () => clock.at });
  async function event(action: string, args: object) {
    const tool = calendar.tools.find(t => t.name === "calendar_" + action)!;
    const api = { snapshot: async () => undefined } as unknown as Parameters<ToolRegistration["execute"]>[1];
    const result = await tool.execute(args, api, context);
    if (!("output" in result) || result.output?.[0]?.type !== "text") throw new Error("Expected calendar result");
    return JSON.parse(result.output[0].text);
  }
  async function open() {
    const app = await openAlter(await openNodeSqliteStorage(join(dir, "main.sqlite")), models, { provider: "faux", modelId: "faux-1" },
      undefined, {}, { timeZone: "Asia/Taipei", plugins: [calendar], now: () => clock.at, setTimer: () => () => {} });
    cleanup.push(app.close);
    const advance = (at: number) => { clock.at = at; app.harness.resume(); };
    return { app, advance };
  }
  return { dir, clock, faux, calendar, event, open, ...await open() };
}

it("calculates local, weekly, interval and signed event times and follows live calendar edits outside the agenda", async () => {
  const { app, advance, event, calendar, faux } = await setup();
  const create = (trigger: Parameters<typeof app.schedules.create>[0]["trigger"]) => app.schedules.create({ brief: "安排", type: "wake", trigger });
  const next = async (id: string) => (await app.schedules.list()).find(item => item.id === id)?.nextAt;
  expect(await next(await create({ kind: "at", at: "2026-11-28T00:03" }))).toBe(initial + 5 * minute);
  expect(await next(await create({ kind: "every", minutes: 7 }))).toBe(initial + 7 * minute);
  expect(await next(await create({ kind: "daily", time: "00:02" }))).toBe(initial + 4 * minute);
  expect(await next(await create({ kind: "daily", time: "23:57", weekdays: [1, 5] }))).toBe(Date.parse("2026-11-30T15:57Z"));
  await expect(create({ kind: "every", minutes: 4 })).rejects.toThrow();
  await expect(create({ kind: "daily", time: "01:30", weekdays: [] })).rejects.toThrow();
  await expect(create({ kind: "daily", time: "24:00" })).rejects.toThrow();
  const { event: meeting } = await event("create", { title: "站会", start: "2026-12-20T10:00" });
  expect(calendar.agenda()).toEqual([]);
  const before = await create({ kind: "event", eventId: meeting.id, anchor: "start", offsetMinutes: -5 });
  const sameMeeting = await create({ kind: "event", eventId: meeting.id, anchor: "end", offsetMinutes: 0 });
  const after = await create({ kind: "event", eventId: meeting.id, anchor: "end", offsetMinutes: 15 });
  expect(await next(before)).toBe(Date.parse("2026-12-20T01:55Z"));
  expect(await next(after)).toBe(Date.parse("2026-12-20T03:15Z"));
  const surface = await observeSurface(app, () => {});
  try {
    app.harness.resume();
    await app.schedules.pause(after, true);
    await event("update", { id: meeting.id, start: new Date(initial + 6 * minute).toISOString(), end: new Date(initial + 10 * minute).toISOString() });
    await expect.poll(() => next(before)).toBe(initial + minute);
    expect(await next(after)).toBe(initial + 25 * minute);
    faux.setResponses([say("收到安排")]);
    advance(initial + minute);
    await expect.poll(() => next(before)).toBeNull();
    await event("delete", { id: meeting.id });
    await event("restore", { id: meeting.id });
    await expect.poll(() => next(after)).toBeUndefined();
    expect(await next(sameMeeting)).toBeUndefined();
    await expect.poll(() => surface.snapshot().timeline.filter(i => i.text.includes("绑定日程已删除"))).toHaveLength(2);
    expect(faux.state.callCount).toBe(1);
  } finally { surface.detach(); }
});

it("persists pause, resumes at the next interval and coalesces downtime to one attributed wake", async () => {
  const f = await setup();
  const id = await f.app.schedules.create({ brief: "继续检查", type: "wake", thinking: "low", trigger: { kind: "every", minutes: 5 } });
  await f.app.schedules.pause(id, true);
  await f.app.close();
  f.clock.at += 21 * minute;
  const g = await f.open();
  g.app.harness.resume();
  await expect.poll(() => g.app.harness.wake()).toMatchObject({ active: false });
  expect(f.faux.state.callCount).toBe(0);
  expect(await g.app.schedules.list()).toMatchObject([{ id, paused: true }]);
  await g.app.schedules.pause(id, false);
  expect(await g.app.schedules.list()).toMatchObject([{ nextAt: initial + 25 * minute }]);
  await g.app.close();
  f.clock.at = initial + 53 * minute;
  f.faux.setResponses([say("收到")]);
  const h = await f.open();
  const surface = await observeSurface(h.app, () => {});
  try {
    h.app.harness.resume();
    await expect.poll(async () => (await readUsage(f.dir)).length).toBe(1);
    expect(await h.app.schedules.list()).toMatchObject([{ nextAt: initial + 55 * minute, lastRun: { dueAt: initial + 25 * minute, missed: true } }]);
    expect(surface.snapshot().timeline).toContainEqual(expect.objectContaining({ kind: "notice", source: "schedule", text: expect.stringContaining("missed") }));
    expect(await readUsage(f.dir)).toMatchObject([{ role: "schedule", conversation: "main", proactive: true, wakeSource: "schedule", thinking: "low" }]);
    const summary = await stats("day", h.app.timeZone, { app: h.app, dir: f.dir });
    expect(summary.wakes.items).toMatchObject([{ wakeSource: "schedule", usage: { calls: 1 } }]);
  } finally { surface.detach(); }
  await h.app.close();
  const i = await f.open();
  i.app.harness.resume();
  await expect.poll(() => i.app.harness.wake()).toMatchObject({ active: false });
  expect(f.faux.state.callCount).toBe(1);
});

it("dispatches ordinary tasks, charges their usage and continues the settled conversation", async () => {
  const f = await setup();
  const finish = () => say(fauxToolCall("finish", { summary: "已记录", refs: [] }), { stopReason: "toolUse" });
  f.faux.setResponses([finish(), say("已完成"), ({ messages }) => {
    expect(messages.some(m => contentText(m.content).includes("原始目标"))).toBe(true);
    return finish();
  }, say("已完成")]);
  async function run(brief: string, at: number, continue_from?: string) {
    const id = await f.app.schedules.create({ brief, type: "task", thinking: "low", ...(continue_from && { continue_from }),
      trigger: { kind: "at", at: new Date(at).toISOString() } });
    f.advance(at);
    const result = () => f.app.harness.snapshot(Tasks, f.app.main.id, context);
    const taskId = `task-${id}-${at}`;
    await expect.poll(async () => (await result())?.byId[taskId]?.status).toBe("completed");
    await f.app.main.waitForIdle(context);
    return { id: taskId, task: (await result())!.byId[taskId]! };
  }
  const first = await run("原始目标", initial + minute);
  const second = await run("接着做", initial + 2 * minute, first.id);
  expect(second.task).toMatchObject({ triggerSource: "scheduled", permission: "restricted", conversationId: first.task.conversationId, continuedFrom: first.id });
  expect((await f.app.harness.snapshot(Ledger, f.app.main.id, context))?.entries).toHaveLength(2);
  const summary = await stats("all", f.app.timeZone, { app: f.app, dir: f.dir });
  expect(summary.byRole.find(r => r.role === "schedule")?.calls).toBe(2);
  expect(summary.tasks.items).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: second.id, rounds: 1, tools: { finish: 1 } })]));
});

it("skips both actions when today's shared budget is exhausted, including after a restart", async () => {
  vi.stubEnv("ALTER_PROACTIVE_DAILY_TOKENS", "1");
  vi.stubEnv("ALTER_HEARTBEAT_HOURS", "22:00-02:00");
  const f = await setup();
  let input = "";
  f.faux.setResponses([({ messages }) => { input = contentText(messages.at(-1)!.content); return say("收到"); }]);
  await f.app.notifications.delivered([{ id: "delivery", title: "交付通知", source: "mail", kind: "event",
    at: initial, level: "now", status: "unread" }]);
  await f.app.schedules.create({ brief: "预算", type: "wake", trigger: { kind: "every", minutes: 5 } });
  f.advance(initial + 5 * minute);
  await expect.poll(async () => (await readUsage(f.dir)).length).toBe(1);
  await f.app.close();
  expect(input).toContain("交付通知");
  const g = await f.open();
  const surface = await observeSurface(g.app, () => {});
  try {
    const wake = surface.snapshot().timeline.find(item => item.source === "schedule");
    expect(wake?.text).toBe("[主会话自己的定时安排]\n预算");
  } finally { surface.detach(); }
  expect(await g.app.heartbeat.run()).toMatchObject({ status: "skipped", skipReason: "budget" });
  await g.app.schedules.create({ brief: "预算", type: "task", trigger: { kind: "at", at: new Date(initial + 10 * minute).toISOString() } });
  g.advance(initial + 10 * minute);
  await expect.poll(async () => (await g.app.schedules.list()).map(item => item.lastRun?.skipped)).toEqual([budgetExhausted, budgetExhausted]);
  expect(f.faux.state.callCount).toBe(1);
  expect(Object.keys((await g.app.harness.snapshot(Tasks, g.app.main.id, context))!.byId)).toHaveLength(0);
});

it("requires ordinary user approval for a scheduled send and skips a continuation while its task runs", async () => {
  const f = await setup();
  f.app.settings.set("off");
  const action = (name: string, args: Parameters<typeof fauxToolCall>[1]) => say(fauxToolCall(name, args), { stopReason: "toolUse" });
  f.faux.setResponses([action("outbox_send", { message: "定时问候" }), action("finish", { summary: "已发送", refs: [] }), say("完成")]);
  const schedule = await f.app.schedules.create({ brief: "发送问候", type: "task", trigger: { kind: "at", at: new Date(initial).toISOString() } });
  f.advance(initial);
  const pending = async () => Object.values((await f.app.harness.snapshot(Requests, f.app.main.id, context))?.pending ?? {}).find(req => !req.checking);
  await expect.poll(pending).toMatchObject({ audience: "user", tool: "outbox_send" });
  const request = (await pending())!;
  expect(f.app.demo.outbox).toEqual([]);
  const taskId = (await f.app.schedules.list()).find(item => item.id === schedule)!.lastRun!.taskId!;
  expect(request.taskId).toBe(taskId);
  const continuation = await f.app.schedules.create({ brief: "接续", type: "task", continue_from: taskId,
    trigger: { kind: "at", at: new Date(initial).toISOString() } });
  await expect.poll(async () => (await f.app.schedules.list()).find(item => item.id === continuation)?.lastRun?.skipped).toBe("接续任务仍在运行");
  expect((await answerUserPermission(f.app.main, { requestId: request.id, decision: "once" })).isError).toBe(false);
  await expect.poll(async () => (await f.app.harness.snapshot(Ledger, f.app.main.id, context))?.entries).toMatchObject([{ taskId, summary: "已发送" }]);
  expect(f.app.demo.outbox).toEqual(["定时问候"]);
});

it("keeps an independent dispatch out of the active heartbeat's task and adoption counts", async () => {
  vi.stubEnv("ALTER_HEARTBEAT_HOURS", "22:00-02:00");
  const f = await setup();
  let finishHeartbeat!: () => void;
  const waiting = new Promise<void>(resolve => { finishHeartbeat = resolve; });
  f.faux.setResponses([say(fauxToolCall("finish", { summary: "探索完毕", refs: [] }), { stopReason: "toolUse" }),
    async () => { await waiting; return say("巡检完成"); },
    say(fauxToolCall("finish", { summary: "定时工作完成", refs: [] }), { stopReason: "toolUse" }), say("已记录")]);
  const id = await f.app.schedules.create({ brief: "独立定时工作", type: "task",
    trigger: { kind: "at", at: new Date(initial + minute).toISOString() } });
  f.app.harness.resume();
  try {
    expect(await f.app.heartbeat.run()).toMatchObject({ status: "ran" });
    await expect.poll(() => f.faux.state.callCount).toBe(2);
    f.advance(initial + minute);
    const taskId = async () => (await f.app.schedules.list()).find(item => item.id === id)?.lastRun?.taskId;
    await expect.poll(taskId).toBeDefined();
    const task = (await f.app.harness.snapshot(Tasks, f.app.main.id, context))!.byId[(await taskId())!]!;
    expect(task.triggerSource).toBe("scheduled");
    expect(task.wakeId).toBeUndefined();
    expect(task.heartbeatAt).toBeUndefined();
  } finally { finishHeartbeat(); }
  await expect.poll(async () => (await readUsage(f.dir)).map(row => row.role)).toEqual(["heartbeat", "heartbeat", "schedule", "main"]);
  expect((await f.app.heartbeat.view()).adoption).toBeCloseTo(0.35);
});

it("migrates action-only rows and edits paused reminders without spending model budget", async () => {
  vi.stubEnv("ALTER_PROACTIVE_DAILY_TOKENS", "0");
  const f = await setup();
  const trigger = { kind: "at" as const, at: new Date(initial + minute).toISOString() };
  const legacy = await f.app.schedules.create({ type: "wake", brief: "旧安排", trigger });
  await f.app.schedules.set({ id: legacy, status: "paused" });
  await f.app.main.commit(async tx => {
    const row = (await tx.doc(ScheduledTasks, f.app.main.id)).byId[legacy]!;
    Reflect.deleteProperty(row.item, "type");
  }, context);
  const id = await f.app.schedules.create({ type: "reminder", brief: "原内容", trigger });
  await f.app.schedules.set({ id, status: "paused", brief: "带文件", thinking: "medium",
    trigger: { kind: "at", at: new Date(initial + 2 * minute).toISOString() } });
  await f.app.close();
  const g = await f.open();
  expect(await g.app.schedules.list()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: legacy, type: "wake", paused: true, nextAt: initial + minute }),
    expect.objectContaining({ id, type: "reminder", brief: "带文件", thinking: "medium", paused: true, nextAt: initial + 2 * minute }),
  ]));
  const notices = async () => (await g.app.harness.snapshot(Notifications, g.app.main.id, context))?.entries ?? [];
  g.advance(initial + 2 * minute);
  await expect.poll(() => g.app.harness.wake().active).toBe(false);
  expect(await notices()).toEqual([]);
  await g.app.schedules.set({ id, status: "active" });
  await expect.poll(notices).toMatchObject([{ kind: "reminder", level: "digest", body: "带文件" }]);
  await g.app.schedules.set({ id, trigger: { kind: "at", at: new Date(initial + 9 * 60 * minute).toISOString() } });
  g.advance(initial + 9 * 60 * minute);
  await expect.poll(notices).toMatchObject([{ kind: "reminder", level: "now" }, { level: "digest" }]);
  expect(await g.app.schedules.set({ id, status: "deleted" })).toBe(true);
  expect(await g.app.schedules.list()).toMatchObject([{ id: legacy }]);
  expect(f.faux.state.callCount).toBe(0);
});

it("keeps event schedules bound to their provider across removal, a colliding ID and a legacy adapter", async () => {
  const { app, event } = await setup();
  const { event: meeting } = await event("create", { title: "周会", start: new Date(initial + 900_000).toISOString() });
  const create = () => app.schedules.create({ type: "reminder", brief: "提醒",
    trigger: { kind: "event", eventId: meeting.id, anchor: "start", offsetMinutes: 0 } });
  const id = await create();
  const other = { capability: { id: "other", actions: [] }, tools: [], calendarEvents: {
    get: () => ({ start: initial + 2, end: initial + 3 }), subscribe: () => () => {},
  } };
  await app.replacePlugin("other", other);
  await expect(create()).rejects.toThrow("Ambiguous schedule event ID");
  await app.replacePlugin("calendar");
  expect(await app.schedules.schedule()).toMatchObject([{ id, nextAt: null }]);
  await create();
  expect(await app.schedules.list()).toMatchObject([{ id, nextAt: initial + 900_000 }, { nextAt: initial + 2 }]);
});
