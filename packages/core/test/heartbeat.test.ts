import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import { obj } from "@earendil-works/pi-schema";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as say, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { interacted } from "../src/feedback-settings.ts";
import { afterEach, expect, it, vi } from "vitest";
import { answerUserPermission, Requests } from "../src/broker.ts";
import type { AlterPlugin } from "../src/capabilities.ts";
import { nextInterval } from "../src/heartbeat.ts";
import { hour } from "../src/heartbeat-state.ts";
import { openAlter } from "../src/main.ts";
import { addNotification, Notifications, updateNotification } from "../src/notifications.ts";
import { observeSurface } from "../src/observe.ts";
import { context, defineTool, openNodeSqliteStorage, reply, type TaskId } from "../src/runtime.ts";
import { Tasks } from "../src/state.ts";
import { submitMessage } from "../src/timeline.ts";
import { readUsage } from "../src/usage.ts";

const start = Date.parse("2026-12-01T08:00Z");
const clean: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { while (clean.length) await clean.pop()!(); } finally { vi.unstubAllEnvs(); }
});
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => say(fauxToolCall(name, args), { stopReason: "toolUse" });
async function setup(plugins: AlterPlugin[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "alter-heartbeat-"));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const clock = { now: start };
  const models = createModels();
  const provider = fauxProvider({ provider: "offline", tokensPerSecond: Infinity });
  models.setProvider(provider.provider);
  const ref = { provider: "offline", modelId: "faux-1" };
  async function open() {
    const app = await openAlter(await openNodeSqliteStorage(join(dir, "main.sqlite")), models, ref, ref, {},
      { plugins, now: () => clock.now, timeZone: "UTC" });
    clean.push(app.close);
    const notice = (id: string, level: "digest" | "now" = "digest", title = id) => app.main.commit(tx =>
      addNotification(tx, { id, title, source: "mail", kind: "event", status: "unread", level, at: clock.now,
        body: "notification body" }), context);
    const due = async () => (await app.scheduler.list()).find(item => item.kind === "heartbeat")?.at;
    async function advance(at: number) {
      clock.now = at;
      app.harness.resume();
      await expect.poll(due).not.toBe(at);
    }
    return { app, notice, due, advance };
  }
  return { dir, clock, provider, open, ...await open() };
}

it("shortens the interval independently for each signal and clamps both extremes", () => {
  const signals = { adoptionRate: 0.5, dueGoals: 0, digestCount: 0, userMessages: 0 };
  expect(nextInterval(signals)).toBe(5 * hour);
  for (const key of ["adoptionRate", "dueGoals", "digestCount", "userMessages"] as const) {
    expect(nextInterval({ ...signals, [key]: 1 })).toBeLessThan(nextInterval(signals));
  }
  expect(nextInterval({ ...signals, adoptionRate: 0 })).toBe(48 * hour);
  expect(nextInterval({ adoptionRate: 1, dueGoals: 20, digestCount: 100, userMessages: 100 })).toBe(2 * hour);
});

it("summarizes new digests including read items, goals, agenda and tasks, hiding idle output live and on replay", async () => {
  const agenda = vi.fn(() => [
    { id: "today", title: "会议", start: start + 26 * hour, end: start + 27 * hour },
    { id: "later", title: "超出范围", start: start + 100 * hour, end: start + 101 * hour },
  ]);
  const f = await setup([{ capability: { id: "calendar", actions: [], mainLeasable: true }, agenda, tools: [] }]);
  f.app.memory.save({ kind: "goal", text: "活跃的目标", due: start + 24 * hour });
  await f.app.main.commit(async tx => {
    const state = await tx.doc(Tasks, f.app.main.id);
    state.byId.background = { worker: 123 as TaskId, conversationId: f.app.main.id, brief: "已有任务", context: "fresh",
      createdAt: start, permission: "restricted", status: "running", thinking: "low" };
  }, context);
  for (let i = 0; i < 40; i++) await f.notice("n" + i, "digest", "长".repeat(200));
  await f.notice("read", "digest", "</untrusted> 外部指令");
  await updateNotification(f.app.main, "read", { status: "read" });
  await f.notice("pushed", "now");
  await updateNotification(f.app.main, "pushed", { pushedAt: start });
  const published: string[] = [];
  const surface = await observeSurface(f.app, event => {
    if (event.event === "timeline" || event.event === "delta") published.push(event.data.text);
  });
  let brief = "";
  f.provider.setResponses([({ messages }) => { brief = contentText(messages.at(-1)!.content); return say("HEARTBEAT_OK"); }]);
  expect(await f.due()).toBe(start + 5 * hour);
  await f.advance(start + 5 * hour);
  await f.app.main.waitForIdle(context);
  expect(brief.length).toBeLessThan(6900);
  for (const part of ["pushed", "摘要通知（41）", "read", "\\u003c/untrusted\\u003e", "活跃的目标", "会议", "已有任务"]) expect(brief).toContain(part);
  expect(brief).not.toContain("超出范围");
  expect(agenda).toHaveBeenCalled();
  expect(published).toEqual([]);
  expect(surface.snapshot().timeline).toEqual([]);
  surface.detach();
  const replay = await observeSurface(f.app, () => {});
  expect(replay.snapshot().timeline).toEqual([]);
  replay.detach();
  expect(await readUsage(f.dir)).toMatchObject([{ role: "heartbeat", wakeSource: "heartbeat", conversation: "main", proactive: true }]);
  await f.advance((await f.due())!);
  expect(f.provider.state.callCount).toBe(1);
});

it("runs an empty first inspection, then skips recently active and unfunded inspections without consuming new digest input", async () => {
  const f = await setup();
  f.provider.setResponses([say("无事")]);
  await f.advance(start + 5 * hour);
  await f.app.main.waitForIdle(context);
  expect(f.provider.state.callCount).toBe(1);
  const upcoming = (await f.due())!;
  f.clock.now = upcoming - 29 * 60_000;
  f.provider.setResponses([say("ok")]);
  await submitMessage(f.app.main, "hello");
  await f.app.main.waitForIdle(context);
  await f.notice("waiting");
  await f.advance(upcoming);
  expect((await f.app.heartbeat.stats()).lastInspection).toBe(start + 5 * hour);
  expect(f.provider.state.callCount).toBe(2);
  const unfunded = (await f.due())!;
  await f.app.close();
  vi.stubEnv("ALTER_PROACTIVE_DAILY_TOKENS", "0");
  const g = await f.open();
  await g.advance(unfunded);
  expect(f.provider.state.callCount).toBe(2);
  expect((await g.app.heartbeat.stats()).lastInspection).toBe(start + 5 * hour);
  await g.app.close();
  vi.stubEnv("ALTER_PROACTIVE_DAILY_TOKENS", "100000");
  const h = await f.open();
  let input = "";
  f.provider.setResponses([({ messages }) => { input = contentText(messages.at(-1)!.content); return say("无事"); }]);
  await h.advance((await h.due())!);
  await h.app.main.waitForIdle(context);
  expect(input).toContain("waiting");
});

it("defers busy main past its due time and skips once over an hour late", async () => {
  const f = await setup();
  f.clock.now = start + 2 * hour;
  await submitMessage(f.app.main, "busy");
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  f.provider.setResponses([async () => { await waiting; return say("done"); }]);
  await f.notice("deferred");
  try {
    await f.advance(start + 5 * hour);
    expect(await f.due()).toBe(start + 5 * hour + 60_000);
    f.clock.now = start + 6 * hour + 60_000;
    f.app.harness.resume();
    await expect.poll(f.due).toBe(f.clock.now + 5 * hour);
    expect((await f.app.heartbeat.stats()).lastInspection).toBeUndefined();
  } finally { finish(); }
  await f.app.main.waitForIdle(context);
});

it("attributes notify and its feedback once per inspection, preserving EWMA and the schedule on restart", async () => {
  const f = await setup();
  await f.notice("digest");
  f.provider.setResponses([call("notify", { level: "now", title: "巡检", body: "提醒" }), say("无事")]);
  const at = start + 5 * hour;
  await f.advance(at);
  await f.app.main.waitForIdle(context);
  const surface = await observeSurface(f.app, () => {});
  expect(surface.snapshot().timeline).toMatchObject([{ kind: "notice", text: "巡检调用 notify" }]);
  const item = surface.snapshot().notifications[0]!;
  expect(item).toMatchObject({ source: "alter", level: "now", kind: "notify", heartbeatAt: at });
  surface.detach();
  for (const feedback of ["useful", "useful", "useless"] as const) {
    await updateNotification(f.app.main, item.id, { feedback });
    expect((await f.app.heartbeat.stats()).adoptionRate).toBeCloseTo(feedback === "useful" ? 0.65 : 0.35);
  }
  expect((await readUsage(f.dir)).filter(row => row.proactive).map(row => row.role)).toEqual(["heartbeat", "heartbeat"]);
  const stats = await f.app.heartbeat.stats();
  const next = await f.due();
  await f.app.close();
  const g = await f.open();
  expect(await g.app.heartbeat.stats()).toEqual(stats);
  expect(await g.due()).toBe(next);
});

it("consumes at most 20 delivered notices atomically, even on retry, tied delivery times and restart", async () => {
  const f = await setup();
  const inputs: string[] = [];
  f.provider.setResponses(Array.from({ length: 3 }, () => ({ messages }) => {
    inputs.push(contentText(messages.at(-1)!.content)); return say("ok");
  }));
  for (let i = 0; i < 25; i++) {
    await f.notice("push-" + i, "now");
    await updateNotification(f.app.main, "push-" + i, { pushedAt: start });
  }
  await f.notice("undelivered", "now");
  f.app.harness.resume();
  await submitMessage(f.app.main, "first", "web", "first");
  await f.app.main.waitForIdle(context);
  expect(inputs[0]!.match(/\["push-/g)).toHaveLength(20);
  expect(inputs[0]).not.toContain("undelivered");
  await f.notice("late", "now", "<".repeat(200));
  await updateNotification(f.app.main, "late", { pushedAt: start });
  await submitMessage(f.app.main, "first", "web", "first");
  await f.app.close();
  const g = await f.open();
  g.app.harness.resume();
  await submitMessage(g.app.main, "second");
  await g.app.main.waitForIdle(context);
  expect(inputs[1]!.split("[当前时间")[0]!.length).toBeLessThanOrEqual(1500);
  expect(inputs[1]).toContain('"late"');
  expect(inputs[1]).not.toContain("push-");
  await submitMessage(g.app.main, "third");
  await g.app.main.waitForIdle(context);
  expect(inputs[2]).not.toContain("<untrusted>");
});

it("keeps claimed external refs silent through triage and restart", async () => {
  const f = await setup();
  await f.app.notifications.claim("shared");
  await f.app.close();
  const g = await f.open();
  f.provider.setResponses([say('{"level":"now","reason":"urgent"}')]);
  await g.app.events.emit({ source: "mail", kind: "received", ref: "shared", at: start, summary: "alert", untrusted: true });
  await expect.poll(async () => (await g.app.harness.snapshot(Notifications, g.app.main.id, context))?.entries)
    .toMatchObject([{ ref: "shared", filtered: "duplicate", level: "silent" }]);
});

it.each([2, 2.01])("attributes a user reply inside the two-hour window (%s hours)", async delay => {
  const f = await setup();
  await f.notice("digest");
  f.provider.setResponses([say("无事"), say("ok"), say("ok")]);
  await f.advance(start + 5 * hour);
  await f.app.main.waitForIdle(context);
  f.clock.now += delay * hour;
  await submitMessage(f.app.main, "follow up", "feishu", "user-1");
  await f.app.main.waitForIdle(context);
  await submitMessage(f.app.main, "again");
  await f.app.main.waitForIdle(context);
  expect((await f.app.heartbeat.stats()).adoptionRate).toBeCloseTo(delay === 2 ? 0.65 : 0.35);
  expect((await readUsage(f.dir)).filter(row => row.proactive).map(row => row.role)).toEqual(["heartbeat"]);
});

it("attributes a completed heartbeat task to its originating inspection and budgets worker requests", async () => {
  const f = await setup();
  await f.notice("digest");
  f.provider.setResponses(Array.from({ length: 8 }, () => ({ messages }) => {
    const last = messages.at(-1)!;
    const text = contentText(last.content);
    if (last.role === "user" && text.includes("定时巡检")) return call("dispatch_task", { brief: "查看资料", context: "fresh", permission: "restricted" });
    if (last.role === "user" && text.endsWith("查看资料")) return call("finish", { summary: "资料已齐", refs: [] });
    return say("收到");
  }));
  await f.advance(start + 5 * hour);
  await expect.poll(async () => (await f.app.heartbeat.stats()).adoptionRate).toBeCloseTo(0.65);
  await f.app.main.waitForIdle(context);
  const tasks = (await f.app.harness.snapshot(Tasks, f.app.main.id, context))!.byId;
  expect(Object.values(tasks)).toMatchObject([{ status: "completed", heartbeatAt: start + 5 * hour }]);
  await expect.poll(async () => (await f.app.heartbeat.view()).runs[0]?.actions)
    .toContainEqual({ tool: "dispatch_task", id: Object.keys(tasks)[0] });
  expect((await readUsage(f.dir)).filter(row => row.proactive).map(row => row.role)).toEqual(Array(3).fill("heartbeat"));
});

it("honors the configured half-open window, disabling and re-enabling a persisted timer", async () => {
  vi.stubEnv("ALTER_HEARTBEAT_HOURS", "20:00-23:00");
  const f = await setup();
  expect(await f.due()).toBe(start + 12 * hour);
  await f.notice("defer until tomorrow");
  f.clock.now = start + 15 * hour;
  f.app.harness.resume();
  await expect.poll(f.due).toBe(start + 36 * hour);
  expect(f.provider.state.callCount).toBe(0);
  await f.app.close();
  vi.stubEnv("ALTER_HEARTBEAT", "off");
  const g = await f.open();
  expect((await g.app.scheduler.list()).filter(s => s.kind === "heartbeat" && s.status === "scheduled")).toEqual([]);
  await g.app.close();
  vi.stubEnv("ALTER_HEARTBEAT", "on");
  const h = await f.open();
  expect((await h.app.scheduler.list()).filter(s => s.kind === "heartbeat")).toMatchObject([{ status: "scheduled", at: start + 36 * hour }]);
});

it("does not count a completed heartbeat task whose requested action the user denied", async () => {
  const f = await setup();
  await f.notice("digest");
  f.provider.setResponses(Array.from({ length: 8 }, () => ({ messages }) => {
    const last = messages.at(-1)!;
    const text = contentText(last.content);
    if (last.role === "user" && text.includes("定时巡检")) return call("dispatch_task", { brief: "检查发件箱", context: "fresh", permission: "auto" });
    if (last.role === "user" && text.endsWith("检查发件箱")) return call("outbox_send", { message: "hello" });
    if (last.role === "toolResult" && last.toolName === "outbox_send") return call("finish", { summary: "用户拒绝", refs: [] });
    return say("收到");
  }));
  await f.advance(start + 5 * hour);
  const pending = async () => Object.values((await f.app.harness.snapshot(Requests, f.app.main.id, context))?.pending ?? {});
  await expect.poll(pending).toMatchObject([{ tool: "outbox_send" }]);
  await answerUserPermission(f.app.main, { requestId: (await pending())[0]!.id, decision: "deny" });
  await expect.poll(async () => Object.values((await f.app.harness.snapshot(Tasks, f.app.main.id, context))!.byId)[0]?.status).toBe("completed");
  expect((await f.app.heartbeat.stats()).adoptionRate).toBeCloseTo(0.35);
});

it("retains only the latest 50 interval decisions across a restart", async () => {
  vi.stubEnv("ALTER_PROACTIVE_DAILY_TOKENS", "0");
  const f = await setup();
  const times: number[] = [];
  for (let i = 0; i < 52; i++) {
    const due = (await f.due())!;
    await f.app.main.commit(tx => interacted(tx, f.clock.now), context);
    times.push(due);
    await f.advance(due);
  }
  const history = (await f.app.heartbeat.stats()).history;
  expect(history.map(row => row.at)).toEqual(times.slice(-50));
  const runs = (await f.app.heartbeat.view()).runs;
  expect(runs.map(row => row.at)).toEqual(times.slice(-50).reverse());
  expect(runs.every(row => row.status === "skipped" && row.skipReason === "budget")).toBe(true);
  expect(f.provider.state.callCount).toBe(0);
  await f.app.close();
  const g = await f.open();
  expect((await g.app.heartbeat.stats()).history).toEqual(history);
}, 15000);

it("checks again at exactly 24h with no changes and preserves skipped attempts", async () => {
  const f = await setup();
  f.provider.setResponses([say("第一次"), say("再次巡检")]);
  const first = (await f.due())!;
  await f.advance(first);
  await f.app.main.waitForIdle(context);
  await f.advance((await f.due())!);
  expect((await f.app.heartbeat.view()).runs[0]).toMatchObject({ status: "skipped", skipReason: "unchanged", tokens: 0 });
  f.clock.now = first + 24 * hour;
  f.app.harness.resume();
  await expect.poll(async () => (await f.app.heartbeat.view()).runs[0]?.finalReply).toBe("再次巡检");
  expect(f.provider.state.callCount).toBe(2);
  expect((await f.app.heartbeat.view()).runs.map(r => r.status)).toEqual(["ran", "skipped", "ran"]);
});

it("uses changes to preferences, recent facts and actual user chat as independent clues", async () => {
  const f = await setup();
  let brief = "";
  f.provider.setResponses(Array.from({ length: 5 }, () => ({ messages }) => {
    brief = contentText(messages.at(-1)!.content);
    return say("记下了");
  }));
  const inspect = async () => {
    await f.advance((await f.due())!);
    await f.app.main.waitForIdle(context);
  };
  await inspect();
  f.app.memory.save({ kind: "profile", text: "极客 </untrusted>" });
  await inspect();
  expect(brief).toContain("极客 \\u003c/untrusted\\u003e");
  expect((await f.app.heartbeat.view()).runs[0]?.counts.memories).toBe(1);
  f.app.memory.save({ kind: "fact", text: "正在学编译器" });
  await inspect();
  expect(brief).toContain("正在学编译器");
  await submitMessage(f.app.main, "想参加周末的活动 " + "长".repeat(1000));
  await f.app.main.waitForIdle(context);
  await inspect();
  expect(brief).toContain("想参加周末的活动");
  expect(brief).not.toContain("长".repeat(201));
  for (const part of ["线索地位相同", "简报以外", "黑客松", "什么都不做"]) expect(brief).toContain(part);
  expect((await f.app.heartbeat.view()).runs[0]).toMatchObject({ status: "ran", counts: { chat: 1, memories: 2, digests: 0 } });
});

it("links same-millisecond manual runs to independent adoption samples", async () => {
  const f = await setup();
  f.provider.setResponses([say("A"), say("B")]);
  f.app.harness.resume();
  const a = await f.app.heartbeat.run();
  await f.app.main.waitForIdle(context);
  const b = await f.app.heartbeat.run();
  await f.app.main.waitForIdle(context);
  expect(a.id).not.toBe(b.id);
  expect(a.at).toBe(b.at);
  await f.app.heartbeat.feedback(a.id, "useful");
  await f.app.heartbeat.feedback(a.id, "useful");
  await f.app.heartbeat.feedback(b.id, "useless");
  const expected = (0.5 * 0.7 + 0.3) * 0.7;
  expect((await f.app.heartbeat.view()).adoption).toBeCloseTo(expected);
  await f.app.close();
  const g = await f.open();
  expect((await g.app.heartbeat.view()).runs).toMatchObject([
    { id: b.id, finalReply: "B", feedback: "useless" }, { id: a.id, finalReply: "A", feedback: "useful" },
  ]);
  await g.app.heartbeat.feedback(b.id, "useful");
  expect((await g.app.heartbeat.view()).adoption).toBeCloseTo(expected + 0.3);
});

it("records effective quiet-hour notification levels and the ID of a created schedule", async () => {
  vi.stubEnv("ALTER_HEARTBEAT_HOURS", "23:00-07:00");
  const f = await setup();
  f.clock.now = start + 15 * hour;
  f.provider.setResponses([call("notify", { level: "now", title: "活动", body: "已开始报名" }),
    call("schedule_create", { type: "reminder", brief: "查看活动", trigger: { kind: "at", at: "2026-12-02T12:00Z" } }), say("已安排")]);
  const run = await f.app.heartbeat.run();
  f.app.harness.resume();
  await expect.poll(async () => (await f.app.heartbeat.view()).runs.find(row => row.id === run.id)?.finalReply).toBe("已安排");
  expect(Object.values((await f.app.harness.snapshot(Requests, f.app.main.id, context))?.pending ?? {})).toEqual([]);
  const record = (await f.app.heartbeat.view()).runs.find(row => row.id === run.id)!;
  expect(record.notified).toBe(true);
  const notice = (await f.app.harness.snapshot(Notifications, f.app.main.id, context))!.entries.find(row => row.kind === "notify")!;
  const schedule = (await f.app.schedules.list()).find(item => item.brief === "查看活动")!;
  expect(record.actions).toEqual([{ tool: "notify", id: notice.id, level: "digest" }, { tool: "schedule_create", id: schedule.id }]);
});

it("extracts a watch ID from a successful tool result and recovers a placed run after restart", async () => {
  const watch = defineTool({ name: "watch_create", description: "Offline watch fixture", parameters: obj({}),
    execute: async () => reply(JSON.stringify({ watchId: "watch-17" })) });
  const f = await setup([{ capability: { id: "watch", mainLeasable: true, actions: [{ name: "create", effect: "write" }] },
    tools: [watch] }]);
  const run = await f.app.heartbeat.run();
  expect(run.finishedAt).toBeNull();
  await f.app.close();
  f.provider.setResponses([call("enable_tool", { capability: "watch", reason: "查看活动" }), call("watch_create", {}), say("准备好了")]);
  const g = await f.open();
  g.app.settings.set("off");
  g.app.harness.resume();
  const pending = async () => Object.values((await g.app.harness.snapshot(Requests, g.app.main.id, context))?.pending ?? {})[0];
  for (const tool of ["enable_tool", "watch_create"]) {
    await expect.poll(pending).toMatchObject({ tool });
    await answerUserPermission(g.app.main, { requestId: (await pending())!.id, decision: "once" });
  }
  await expect.poll(async () => (await g.app.heartbeat.view()).runs[0]?.finalReply).toBe("准备好了");
  expect((await g.app.heartbeat.view()).runs[0]).toMatchObject({ id: run.id, notified: false,
    actions: [{ tool: "enable_tool" }, { tool: "watch_create", id: "watch-17" }] });
});
