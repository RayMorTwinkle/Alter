import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, createCapabilityRegistry, type ToolRegistration } from "@alter/core";
import { afterEach, expect, it } from "vitest";
import { createCalendarPlugin } from "../src/index.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function setup(timeZone = "Asia/Shanghai") {
  const dataDir = await mkdtemp(join(tmpdir(), "alter-calendar-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  let at = Date.parse("2026-11-22T17:00Z"); // Already Monday in Shanghai.
  const plugin = () => createCalendarPlugin({ dataDir, timeZone, now: () => at++ });
  let active = plugin();
  let stop = await active.start!({ emit: async () => {} });
  cleanup.push(() => stop());
  async function call(action: string, args: object = {}) {
    const tool = active.tools.find(t => t.name === "calendar_" + action)!;
    const result = await tool.execute(args, {} as Parameters<ToolRegistration["execute"]>[1], context);
    if (!("output" in result) || result.output?.[0]?.type !== "text") throw new Error("Expected calendar text");
    expect(result.details).toBeUndefined();
    return JSON.parse(result.output[0].text);
  }
  return { plugin: active, call, async reopen() {
    await stop();
    active = plugin();
    stop = await active.start!({ emit: async () => {} });
  } };
}

it("replaces the demo manifest and declares the effects of exactly five leasable tools", async () => {
  const { plugin } = await setup();
  const { toolActions, manifests } = createCapabilityRegistry([plugin]);
  expect(manifests.filter(m => m.id === "calendar")).toEqual([plugin.capability]);
  expect(plugin.capability.mainLeasable).toBe(true);
  expect(plugin.tools.map(tool => [tool.name, toolActions.get(tool.name)?.effect])).toEqual([
    ["calendar_list", "read"], ["calendar_create", "write-local"], ["calendar_update", "write-local"],
    ["calendar_delete", "write-local"], ["calendar_restore", "write-local"],
  ]);
  expect(() => createCapabilityRegistry([plugin, plugin])).toThrow("Duplicate capability");
});

it("persists local times, metadata and soft deletion across reopen and restore", async () => {
  const { call, reopen } = await setup();
  const { event } = await call("create", { title: "站会", start: "2026-11-23T15:00", location: "A", notes: "议程" });
  expect(event).toMatchObject({ id: expect.stringMatching(/^evt_/), start: "2026-11-23T15:00:00.000+08:00",
    startLabel: "2026-11-23 15:00 (周一)", startZone: "Asia/Shanghai", end: "2026-11-23T16:00:00.000+08:00", allDay: false });
  const { id } = event;
  const edit = await call("update", { id, start: "2026-11-24T09:30:01.125-05:00", end: "2026-11-24T10:30:01.125-05:00", title: "复盘", notes: "新议程" });
  expect(edit.event).toMatchObject({ id, startZone: "-05:00", start: "2026-11-24T22:30:01.125+08:00",
    end: "2026-11-24T23:30:01.125+08:00", createdAt: event.createdAt, location: "A", notes: "新议程" });
  expect(edit.event.updatedAt).not.toBe(event.updatedAt);
  expect((await call("delete", { id })).deletedAt).toBeTruthy();
  await reopen();
  expect(await call("list")).toEqual([]);
  expect(await call("list", { includeDeleted: true })).toMatchObject([{ id, deletedAt: expect.any(String) }]);
  await call("restore", { id });
  await reopen();
  const [saved] = await call("list");
  expect(saved).toMatchObject({ id, title: "复盘", start: edit.event.start, notes: "新议程" });
  expect(saved).not.toHaveProperty("deletedAt");
});

it("lists overlaps in start order over seven local dates, with exclusive ends", async () => {
  const { call } = await setup();
  for (const [title, start] of [
    ["upper", "2026-11-30"], ["later", "2026-11-29T23:59"], ["carry", "2026-11-22T23:30"], ["before", "2026-11-22T23:00"],
  ]) await call("create", { title, start });
  expect((await call("list")).map((e: { title: string }) => e.title)).toEqual(["carry", "later"]);
  expect(await call("list", { from: "2026-11-22T16:30Z", to: "2026-11-29" })).toEqual([]);
  await expect(call("list", { from: "2026-11-23", to: "2026-11-23" })).rejects.toThrow(/after/);
});

it("reports create and update conflicts without blocking or counting adjacent, deleted or self events", async () => {
  const { call } = await setup();
  const add = async (start: string) => call("create", { title: "会", start: "2026-11-23T" + start });
  const a = await add("09:00");
  const b = await add("10:00");
  const c = await add("09:45");
  expect(b.conflicts).toEqual([]);
  expect(c.conflicts.map((e: { id: string }) => e.id)).toEqual([a.event.id, b.event.id]);
  await call("delete", { id: a.event.id });
  const moved = await call("update", { id: c.event.id, start: "2026-11-23T09:30" });
  expect(moved.event.end).toBe(c.event.end);
  expect(moved.conflicts.map((e: { id: string }) => e.id)).toEqual([b.event.id]);
  expect(await call("list")).toHaveLength(2);
});

it("rejects invalid dates and nonpositive intervals without changing saved events", async () => {
  const { call } = await setup();
  const base = { title: "test", start: "2026-11-23T12:00" };
  for (const end of [base.start, "2026-11-23T11:00"]) await expect(call("create", { ...base, end })).rejects.toThrow(/after/);
  await expect(call("create", { ...base, start: "2026-02-30" })).rejects.toThrow(/Invalid/);
  const { event } = await call("create", base);
  await expect(call("update", { id: event.id, title: "lost", end: base.start })).rejects.toThrow(/after/);
  await expect(call("update", { id: event.id, start: event.end })).rejects.toThrow(/after/);
  expect(await call("list")).toEqual([event]);
});

it("uses local midnight across DST for all-day events and disambiguates repeated hours", async () => {
  const { call } = await setup("America/New_York");
  const { event } = await call("create", { title: "全天", start: "2026-03-08", allDay: true });
  expect(event).toMatchObject({ start: "2026-03-08T00:00:00.000-05:00", end: "2026-03-09T00:00:00.000-04:00" });
  const moved = await call("update", { id: event.id, start: "2026-11-01", end: "2026-11-02" });
  expect(moved.event).toMatchObject({ start: "2026-11-01T00:00:00.000-04:00", end: "2026-11-02T00:00:00.000-05:00" });
  await expect(call("create", { title: "gap", start: "2026-03-08T02:30" })).rejects.toThrow(/does not exist/);
  const fold = await call("create", { title: "fold", start: "2026-11-01T01:30" });
  expect(fold.event).toMatchObject({ start: "2026-11-01T01:30:00.000-04:00", end: "2026-11-01T01:30:00.000-05:00" });
  const late = await call("create", { title: "second", start: "2026-11-01T01:30-05:00" });
  expect(late.event.start).toBe(fold.event.end);
});

it("handles a half-hour fold and a local day whose first valid time is 01:00", async () => {
  const lordHowe = await setup("Australia/Lord_Howe");
  const fold = await lordHowe.call("create", { title: "fold", start: "2026-04-05T01:45" });
  expect(fold.event).toMatchObject({ start: "2026-04-05T01:45:00.000+11:00", end: "2026-04-05T02:15:00.000+10:30" });
  const santiago = await setup("America/Santiago");
  const day = await santiago.call("create", { title: "全天", start: "2024-09-08", allDay: true });
  expect(day.event).toMatchObject({ start: "2024-09-08T01:00:00.000-03:00", end: "2024-09-09T00:00:00.000-03:00" });
});
