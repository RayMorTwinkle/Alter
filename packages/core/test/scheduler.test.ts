import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { expect, it, vi } from "vitest";
import { calendarTime } from "../src/calendar-time.ts";
import { openAlter } from "../src/main.ts";
import { Notifications } from "../src/notifications.ts";
import { observeSurface } from "../src/observe.ts";
import { context, openNodeSqliteStorage, type HarnessOptions } from "../src/runtime.ts";

it("interprets offsets, validates wall times and advances by local calendar day", () => {
  const ny = calendarTime("America/New_York");
  const taipei = calendarTime("Asia/Taipei");
  expect(taipei.parse("2026-12-01T00:05").ms).toBe(Date.parse("2026-11-30T16:05Z"));
  expect(taipei.parse("2026-12-01T00:05:01.123-05:00").ms).toBe(Date.parse("2026-12-01T05:05:01.123Z"));
  expect(() => taipei.parse("2026-02-30T10:00")).toThrow();
  expect(() => ny.parse("2026-03-08T02:30")).toThrow();
  expect(() => ny.nextDaily(0, "24:00")).toThrow();
  expect(ny.nextDaily(Date.parse("2026-03-07T14:00Z"), "09:00")).toBe(Date.parse("2026-03-08T13:00Z"));
  expect(ny.nextDaily(Date.parse("2026-03-08T06:00Z"), "02:30")).toBe(Date.parse("2026-03-08T07:30Z"));
  expect(ny.nextDaily(Date.parse("2026-11-01T04:00Z"), "01:30")).toBe(Date.parse("2026-11-01T05:30Z"));
  expect(ny.nextDaily(Date.parse("2026-11-01T05:30Z"), "01:30")).toBe(Date.parse("2026-11-02T06:30Z"));
  for (const [time, quiet] of [["22:59", false], ["23:00", true], ["07:59", true], ["08:00", false]] as const) {
    expect(taipei.quietHours(taipei.parse("2026-12-01T" + time).ms)).toBe(quiet);
  }
});

it("sleeps durably, fires once per occurrence, catches up once and resumes registered kinds", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "alter-schedule-"));
  let now = Date.parse("2026-12-01T00:00Z");
  const timers = new Map<() => void, number>();
  const setTimer: HarnessOptions["setTimer"] = (callback, delay) => {
    timers.set(callback, now + delay);
    return () => timers.delete(callback);
  };
  const advance = (iso: string) => {
    now = Date.parse(iso);
    for (const [callback, due] of [...timers]) if (due <= now) { timers.delete(callback); callback(); }
  };
  const open = async () => openAlter(await openNodeSqliteStorage(join(dir, "main.sqlite")), createModels(),
    { provider: "unused", modelId: "unused" }, undefined, {}, { timeZone: "Asia/Taipei", now: () => now, setTimer });
  let app = await open();
  onTestFinished(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const handler = vi.fn();
  app.scheduler.register("review", handler);
  const create = (text: string, at: string, daily?: string, kind = "reminder") => app.scheduler.create({ kind, text, at, daily });
  const once = await create("打电话", "2026-12-01T09:00");
  const missed = await create("缴费", "2026-12-02T11:00");
  const repeat = await create("晨会", "2026-12-01T10:00", "10:00");
  const cancelled = await create("撤销", "2026-12-01T09:30");
  await create("复查", "2026-12-01T11:00", undefined, "review");
  app.harness.resume();
  const expectWake = (iso: string) => expect.poll(() => app.harness.wake()).toMatchObject({ active: false, at: Date.parse(iso) });
  const notifications = async () => (await app.harness.snapshot(Notifications, app.main.id, context))?.entries ?? [];
  await expectWake("2026-12-01T01:00Z");
  expect(await app.scheduler.cancel(cancelled)).toBe(true);
  await app.close();
  app = await open();
  app.harness.resume();
  await expectWake("2026-12-01T01:00Z");
  advance("2026-12-01T01:00Z");
  await expect.poll(async () => (await notifications()).length).toBe(1);
  expect(await notifications()).toMatchObject([{ id: once + "-" + now, at: now, level: "now", body: "打电话" }]);
  await expectWake("2026-12-01T02:00Z");
  await app.close();
  advance("2026-12-05T17:00Z"); // 01:00 on Dec 6 locally; five missed occurrences
  app = await open();
  app.scheduler.register("review", handler);
  app.harness.resume();
  await expectWake("2026-12-06T02:00Z");
  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler.mock.calls[0]![0]).toMatchObject({ kind: "review", text: "复查" });
  const caughtUp = await notifications();
  expect(caughtUp).toHaveLength(3);
  expect(caughtUp).toEqual(expect.arrayContaining([
    expect.objectContaining({ at: now, level: "digest", body: "晨会" }),
    expect.objectContaining({ at: now, level: "digest", body: "缴费" }),
  ]));
  expect(await app.scheduler.list()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: repeat, at: Date.parse("2026-12-06T02:00Z"), repeat: { daily: "10:00" } }),
    expect.objectContaining({ id: once, status: "done" }), expect.objectContaining({ id: missed, status: "done" }), expect.objectContaining({ id: cancelled, status: "cancelled" }),
  ]));
  await app.close();
  app = await open();
  const surface = await observeSurface(app, () => {});
  try {
    app.harness.resume();
    await expectWake("2026-12-06T02:00Z");
    expect(surface.snapshot().notifications).toEqual(caughtUp);
    advance("2026-12-06T02:00Z");
    await expectWake("2026-12-07T02:00Z");
    expect(new Set(surface.snapshot().notifications.map(item => item.id)).size).toBe(4);
    expect(surface.snapshot()).toMatchObject({ busy: false, timeline: [], tasks: [], ledger: [] });
    expect(await app.scheduler.cancel(repeat)).toBe(true);
    await expect.poll(() => app.harness.wake().at).toBeUndefined();
  } finally { surface.detach(); }
});

it("rolls back a failed handler and keeps the latest 500 notifications on retry", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "alter-schedule-retry-"));
  let now = Date.parse("2026-12-01T01:00Z");
  const app = await openAlter(await openNodeSqliteStorage(join(dir, "main.sqlite")), createModels(),
    { provider: "unused", modelId: "unused" }, undefined, {}, { now: () => now });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(async () => { warn.mockRestore(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const item = { kind: "reminder", title: "提醒", at: now, source: "schedule", level: "now", status: "unread" } as const;
  await app.main.commit(async tx => {
    const { entries } = await tx.doc(Notifications, app.main.id);
    for (let i = 500; i > 0; i--) entries.push({ ...item, id: String(i) });
  }, context);
  let attempts = 0;
  app.scheduler.register("review", async (_, tx) => {
    const { entries } = await tx.doc(Notifications, app.main.id);
    entries[0]!.feedback = "useful";
    if (++attempts === 1) throw new Error("transient");
  });
  const at = new Date(now).toISOString();
  await app.scheduler.create({ kind: "review", text: "review", at });
  app.harness.resume();
  const entries = async () => (await app.harness.snapshot(Notifications, app.main.id, context))!.entries;
  await expect.poll(() => app.harness.wake()).toMatchObject({ active: false, at: now + 60_000 });
  expect((await entries())[0]!.feedback).toBeUndefined();
  now += 60_000;
  app.harness.resume();
  await expect.poll(async () => (await entries())[0]?.feedback).toBe("useful");
  await app.scheduler.create({ kind: "reminder", text: "最近一条", at });
  await expect.poll(async () => (await entries())[0]?.body).toBe("最近一条");
  const retained = await entries();
  expect(retained).toHaveLength(500);
  expect(retained.at(-1)?.id).toBe("2");
  expect(attempts).toBe(2);
});
