import { expect, it, vi } from "vitest";
import { context, defineTool, reply, schema, submitMessage, type AlterApp, type PluginRouteContext, type PluginSseFeed } from "@alter/core";
import { MemoryInbox } from "../../core/src/memory-inbox.ts";
import { say, toolCall } from "../../core/test/fixtures/gateway.ts";
import { createPluginManager, type PluginDefinition } from "../src/plugin-manager.ts";
import { setup, stream } from "./web-fixture.ts";

it("hosts a new messaging and agenda plugin across authenticated HTTP, SSE, SQLite and live replacement", async () => {
  const start = Date.parse("2026-11-24T12:00:00+08:00");
  let now = start;
  const where = { channel: "wechat", chatId: "team" };
  const meeting = "wechat/meeting";
  const summary = "团队工作台（查看会议安排）";
  const authorize = vi.fn(async () => {});
  const polls = vi.fn(async () => [{ source: "wechat", kind: "message", chatId: "team", at: start + 10,
    ref: "team-1", summary: "会议确定", untrusted: true as const }]);
  const senders: ((text: string) => Promise<string>)[] = [];
  const editions: ReturnType<typeof edition>[] = [];
  function edition(version: number) {
    let due = start + version * 300_000;
    const changes = new Set<(id: string) => void>();
    const listen = (fn: (id: string) => void) => { changes.add(fn); return () => { changes.delete(fn); }; };
    const snapshot = () => ({ version, due });
    const feed: PluginSseFeed = { event: "team-agenda", snapshot, subscribe: listen, onConnect: true };
    const events = { get: (id: string) => id === meeting ? { start: due, end: due + 60_000 } : undefined, subscribe: listen };
    return { changes, move(at: number) { due = at; for (const fn of changes) fn(meeting); },
      instance: { externalDelivery: true, status: () => ({ state: "ok" as const }), sse: [feed],
        routes: [{ method: "GET" as const, path: "/api/team/agenda",
          handle: ({ json }: PluginRouteContext) => json(200, snapshot()) }],
        surface: { id: "wechat", label: "微信", async start(app: AlterApp) {
          senders.push(text => submitMessage(app.main, text, "wechat"));
          return async () => {};
        } },
        plugin: { capability: { id: "wechat", summary, actions: [{ name: "meeting", effect: "read" as const }] },
          tools: [defineTool({ name: "wechat_meeting", description: "Read team meeting time.", parameters: schema.obj({}),
            execute: async () => reply(String(due)) })],
          agenda: () => [{ id: meeting, title: "周会", ...events.get(meeting)! }], scheduleEvents: events,
          watchSource: { authorize, poll: polls } },
      } };
  }
  const definition: PluginDefinition = { description: { id: "wechat", name: "团队工作台", settings: [],
    provides: { channels: ["wechat"], capabilities: ["wechat"], sources: ["wechat"] } },
    open() { const next = edition(editions.length + 1); editions.push(next); return next.instance; } };
  const prompts: string[] = [];
  const web = await setup(({ messages, model }, res) => {
    if (model === "offline/task") return toolCall(res, "finish", { summary: "已核对周会", refs: [] });
    const last = messages.at(-1)!;
    if (last.role === "user" && last.content.endsWith("\n留意会议")) {
      prompts.push(...messages.map(m => m.content));
      return toolCall(res, "watch", { brief: "留意会议", where, until: 10 });
    }
    say(res, "收到");
  }, false, undefined, () => now, (app, dir) => createPluginManager(app, dir, [definition]));
  const path = "/api/team/agenda";
  expect((await web.read(path)).status).toBe(401);
  await web.login();
  const feed = await stream<never, { event: "team-agenda"; data: { version: number; due: number } | null }>(web.read);
  const agenda = async () => (await web.read(path)).json();
  expect(await agenda()).toEqual({ version: 1, due: start + 300_000 });
  await feed.seen(e => e.event === "team-agenda" && e.data?.version === 1);
  const id = await senders[0]!("留意会议");
  await web.app.main.waitForIdle(context);
  expect(prompts.join("\n")).toContain(summary);
  expect(prompts.join("\n")).toContain("[用户消息 · 微信 · ");
  const entries = await web.app.main.entries({}, 50, undefined, context);
  expect(entries.items).toContainEqual(expect.objectContaining({ kind: "alter.user-input",
    data: expect.objectContaining({ id, source: "wechat", sourceLabel: "微信", userChannel: true }) }));
  expect((await web.app.harness.snapshot(MemoryInbox, web.app.main.id, context))?.messages)
    .toContainEqual({ id, at: start, text: "留意会议" });
  expect((await web.state()).notifications).toContainEqual(expect.objectContaining({ kind: "message", body: "收到", channel: "wechat" }));
  expect(await (await web.read("/api/stats")).json()).toMatchObject({ wakes: { bySource: { "user-wechat": 1 } } });
  expect(await (await web.read("/api/funnel?days=1")).json()).toMatchObject({ days: [{ triggered: 1, pushed: 0 }] });
  expect(authorize).toHaveBeenCalledWith(where);
  expect(await (await web.read("/api/watches")).json()).toMatchObject([{ where, status: "running" }]);
  now += 60_000;
  web.app.harness.resume();
  await expect.poll(() => web.app.notifications.isClaimed("team-1")).toBe(true);
  expect(polls).toHaveBeenCalledWith(where, start, now);
  const [watch] = await web.app.watches.list();
  await web.app.watches.cancel(watch!.id);

  const trigger = { kind: "event" as const, eventId: meeting, anchor: "start" as const, offsetMinutes: -1 };
  await web.app.schedules.create({ type: "reminder", trigger, brief: "周会即将开始" });
  const nextAt = async () => (await web.app.schedules.list())[0]?.nextAt;
  expect(await nextAt()).toBe(start + 240_000);
  editions[0]!.move(start + 480_000);
  await expect.poll(nextAt).toBe(start + 420_000);
  await feed.seen(e => e.event === "team-agenda" && e.data?.due === start + 480_000);

  async function toggle(enabled: boolean) {
    const res = await fetch(web.base + "/api/plugins/wechat", { method: "PATCH",
      headers: { cookie: web.sessionCookie(), "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
    expect(await res.json()).toMatchObject({ enabled, status: { state: enabled ? "ok" : "off" } });
  }
  await toggle(false);
  expect(editions[0]!.changes.size).toBe(0);
  await feed.seen(e => e.event === "team-agenda" && e.data === null);
  expect((await web.read(path)).status).toBe(404);
  await expect(web.app.watches.create({ brief: "观察", where, until: 2 })).rejects.toThrow(/wechat.*未配置/);
  await toggle(true);
  await feed.seen(e => e.event === "team-agenda" && e.data?.version === 2);
  expect(await agenda()).toEqual({ version: 2, due: start + 600_000 });
  expect(await nextAt()).toBe(start + 540_000);
  editions[0]!.move(start + 120_000);
  editions[1]!.move(now + 60_000);
  await expect.poll(async () => (await web.state()).notifications.filter(n => n.kind === "reminder"))
    .toMatchObject([{ body: "周会即将开始" }]);
  await feed.seen(e => e.event === "team-agenda" && e.data?.version === 2 && e.data.due === now + 60_000);
  expect(await nextAt()).toBeNull();
  await web.close();
  const restored = await web.reopen();
  await restored.login();
  expect((await restored.state()).timeline).toContainEqual(expect.objectContaining({ id, kind: "user", source: "wechat", sourceLabel: "微信", text: "留意会议" }));
  expect((await restored.app.harness.snapshot(MemoryInbox, restored.app.main.id, context))?.messages).toContainEqual({ id, at: start, text: "留意会议" });
  const inspection = await (await restored.post("/api/heartbeat/run")).json();
  expect(inspection.counts.agenda).toBe(1);
  await expect.poll(async () => (await restored.app.heartbeat.view()).runs.find(r => r.id === inspection.id)?.finishedAt)
    .toEqual(expect.any(Number));
});
