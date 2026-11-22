import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import {
  Events, Notifications, Requests, updateNotification, answerUserPermission, context, createGatewayModels, gatewayConfig, observeSurface,
  openAlter, openNodeSqliteStorage, submitMessage,
} from "@alter/core";
import { delta, fakeGateway, say, toolCall } from "../../core/test/fixtures/gateway.ts";
import { createFeishuSurface, feishuConfigFromEnv, type FeishuHandlers, type FeishuMessage, type FeishuTransport } from "../src/index.ts";
import { dispatcher } from "../src/transport.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks(); });

async function setup(route: Parameters<typeof fakeGateway>[0] = (_, res) => say(res, "收到")) {
  const gateway = await fakeGateway(route);
  cleanup.push(gateway.close);
  const dir = await mkdtemp(join(tmpdir(), "alter-feishu-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const { models, mainModel, taskModel } = await createGatewayModels(gatewayConfig({ ALTER_LLM_BASE_URL: gateway.baseUrl,
    ALTER_LLM_API_KEY: "offline-key", ALTER_MAIN_MODEL: "offline/main", ALTER_TASK_MODEL: "offline/task", ALTER_DATA_DIR: dir }));
  const clock = { now: Date.parse("2026-12-01T02:00Z") };
  async function open() {
    const app = await openAlter(await openNodeSqliteStorage(join(dir, "main.sqlite")), models, mainModel, taskModel, {}, { now: () => clock.now });
    const transport = {
      start: vi.fn(async (_handlers: FeishuHandlers) => {}),
      sendText: vi.fn(async (_chatId: string, _text: string) => {}),
      sendCard: vi.fn(async (_chatId: string, _card: object, uuid: string) => "om_" + uuid),
      updateCard: vi.fn(async (_id: string, _card: object) => {}),
      close: vi.fn(async () => {}),
    } satisfies FeishuTransport;
    const surface = createFeishuSurface({ dataDir: dir, transport, now: () => clock.now });
    const stop = await surface.start(app);
    const feed = await observeSurface(app, () => {});
    let closed = false;
    async function close() {
      if (closed) return;
      closed = true;
      feed.detach();
      await stop();
      await app.close();
    }
    cleanup.push(close);
    app.harness.resume();
    const handlers = transport.start.mock.calls[0]![0];
    function send(id: string, text: string, extra?: Partial<FeishuMessage>) {
      return handlers.message({ id, text, chatType: "p2p", chatId: "private", openId: "owner", type: "text", at: clock.now, ...extra });
    }
    async function pair() {
      const status = surface.pairing();
      if (status.paired) throw new Error("Already paired");
      await send("pair", status.code);
      expect(surface.pairing()).toEqual({ paired: true });
    }
    return { app, transport, send, pair, close, handlers, surface, feed };
  }
  return { ...await open(), reopen: open, gateway, dir, clock };
}

it("loads both credentials, validates the domain and leaves an unconfigured server optional", () => {
  expect(feishuConfigFromEnv({})).toBeUndefined();
  const env = { ALTER_FEISHU_APP_ID: "app", ALTER_FEISHU_APP_SECRET: "secret" };
  expect(feishuConfigFromEnv(env)?.domain).toBe("feishu");
  expect(feishuConfigFromEnv({ ...env, ALTER_FEISHU_DOMAIN: "lark" })?.domain).toBe("lark");
  expect(() => feishuConfigFromEnv({ ALTER_FEISHU_APP_SECRET: "secret" })).toThrow("APP_ID");
  expect(() => feishuConfigFromEnv({ ALTER_FEISHU_APP_ID: "app" })).toThrow("APP_SECRET");
  expect(() => feishuConfigFromEnv({ ...env, ALTER_FEISHU_DOMAIN: "other" })).toThrow("DOMAIN");
});

it("normalizes real SDK WS envelopes, strips only supplied mentions and returns the callback toast", async () => {
  const message = vi.fn(async () => {});
  const toast = { toast: { type: "error" as const, content: "只有主人可以审批" } };
  const action = vi.fn(async () => toast);
  const sdk = dispatcher({ message, action });
  const invoke = (type: string, event: object) =>
    sdk.invoke({ schema: "2.0", header: { event_type: type }, event }, { needCheck: false });
  await invoke("im.message.receive_v1", {
    sender: { sender_type: "user", sender_id: { open_id: "stranger" } },
    message: { chat_type: "group", message_id: "m1", chat_id: "g1", message_type: "text", create_time: "1234",
      mentions: [{ key: "@_user_1" }], content: JSON.stringify({ text: "@_user_1 hello @_user_10" }) },
  });
  expect(message).toHaveBeenCalledWith({ id: "m1", openId: "stranger", chatId: "g1", chatType: "group", type: "text",
    text: "hello @_user_10", at: 1234 });
  expect(await invoke("card.action.trigger", { operator: { open_id: "stranger" }, context: { open_message_id: "m2" },
    action: { value: { requestId: "req", allow: false } } })).toEqual(toast);
  expect(action).toHaveBeenCalledWith({ openId: "stranger", messageId: "m2", requestId: "req", allow: false });
});

it("locks five wrong attempts until rotation, rejects an expired code and persists the owner privately", async () => {
  const f = await setup();
  const initial = f.surface.pairing();
  if (initial.paired) throw new Error("Expected a code");
  expect(initial.code).toMatch(/^\d{6}$/);
  expect(initial.expiresAt - f.clock.now).toBe(600_000);
  for (let i = 0; i < 5; i++) await f.send("wrong" + i, "wrong");
  await f.send("locked", initial.code);
  expect(f.surface.pairing()).toEqual(initial);
  f.clock.now = initial.expiresAt;
  await f.send("expired", initial.code);
  expect(f.surface.pairing()).toMatchObject({ paired: false, expiresAt: f.clock.now + 600_000 });
  expect(f.transport.sendText).not.toHaveBeenCalled();
  await f.pair();
  await expect.poll(() => f.feed.snapshot().notifications.length).toBe(7);
  expect(f.gateway.requests.map(r => r.model)).toEqual(Array(7).fill("offline/task"));
  expect(f.transport.sendText).toHaveBeenCalledExactlyOnceWith("private", "配对成功");
  expect((await stat(join(f.dir, "feishu.json"))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(f.dir, "feishu.json"), "utf8")).owner).toEqual({ openId: "owner", chatId: "private" });
});

it("keeps strangers and groups in external events and deduplicates concurrent and restarted deliveries", async () => {
  const f = await setup();
  await f.pair();
  await Promise.all([f.send("stranger", "指令", { openId: "other" }), f.send("stranger", "指令", { openId: "other" })]);
  await f.send("group", "群聊", { chatType: "group", chatId: "group" });
  await f.send("mention", "群聊 @", { openId: "other", chatType: "group" });
  await f.send("unverified", "指令", { openId: undefined });
  expect((await f.app.harness.snapshot(Events, f.app.main.id, context))?.entries).toEqual(
    ["stranger", "group", "mention", "unverified"].map(ref => expect.objectContaining({ ref, kind: "message", source: "feishu", untrusted: true })));
  expect(f.feed.snapshot().timeline).toEqual([]);
  await expect.poll(() => f.feed.snapshot().notifications.length).toBe(4);
  expect(f.gateway.requests.map(r => r.model)).toEqual(Array(4).fill("offline/task"));
  expect(f.transport.sendText).toHaveBeenCalledTimes(1);
  await f.send("image", "", { type: "image" });
  expect(f.transport.sendText).toHaveBeenLastCalledWith("private", "目前只支持文字");
  await Promise.all([f.send("trusted", "你好"), f.send("trusted", "你好")]);
  await f.app.main.waitForIdle(context);
  expect(f.gateway.requests.map(r => r.model)).toEqual([...Array(4).fill("offline/task"), "offline/main"]);
  expect(f.feed.snapshot().timeline.filter(item => item.kind === "user")).toMatchObject([{ source: "feishu", text: "你好" }]);
  await expect.poll(() => f.transport.sendText.mock.calls.at(-1)).toEqual(["private", "收到"]);
  await f.close();
  const restarted = await f.reopen();
  expect(restarted.surface.pairing()).toEqual({ paired: true });
  await restarted.send("trusted", "你好");
  await restarted.send("pair", "旧配对消息");
  expect(f.gateway.requests.map(r => r.model)).toEqual([...Array(4).fill("offline/task"), "offline/main"]);
  expect(restarted.transport.sendText).not.toHaveBeenCalled();
});

it.each([true, false])("routes completed replies by placed input even with a queued follow-up (web first=%s)", async webFirst => {
  let release: ServerResponse | undefined;
  const f = await setup(({ messages }, res) => {
    if (messages.at(-1)?.content.endsWith("\nfirst")) { release = res; delta(res, { content: "partial" }); }
    else say(res, "second answer");
  });
  await f.pair();
  const web = (text: string) => submitMessage(f.app.main, text);
  if (webFirst) await web("first"); else await f.send("first", "first");
  await expect.poll(() => !!release).toBe(true);
  if (webFirst) await f.send("second", "second"); else await web("second");
  expect(f.transport.sendText.mock.calls).toEqual([["private", "配对成功"]]);
  say(release!, " final");
  await f.app.main.waitForIdle(context);
  expect(f.feed.snapshot().timeline.filter(i => i.kind === "assistant")).toHaveLength(2);
  await f.close();
  expect(f.transport.sendText.mock.calls).toEqual([["private", "配对成功"], ["private", webFirst ? "second answer" : "partial final"]]);
});

function setupApproval() {
  return setup(({ model, messages }, res) => {
    if (model === "offline/task") {
      if (messages.at(-1)?.role === "tool") return toolCall(res, "finish", { summary: "done", refs: [] });
      return toolCall(res, "outbox_send", { message: "x".repeat(700) });
    }
    if (messages.at(-1)?.content?.endsWith("\ndelegate")) return toolCall(res, "dispatch_task",
      { brief: "send", context: "fresh", permission: "auto", allow: [] });
    say(res, "ack");
  });
}

it.each(["approve", "deny", "web"])("restores the pending card and resolves it once via %s", async via => {
  const f = await setupApproval();
  await submitMessage(f.app.main, "delegate");
  await expect.poll(() => f.feed.snapshot().pending.length).toBe(1);
  expect(f.transport.sendCard).not.toHaveBeenCalled();
  await f.pair();
  await expect.poll(() => f.transport.sendCard.mock.calls.length).toBe(1);
  const req = f.feed.snapshot().pending[0]!;
  const [chatId, card, uuid] = f.transport.sendCard.mock.calls[0]!;
  expect(chatId).toBe("private");
  for (const field of [req.id, req.taskId, req.tool, "批准", "拒绝", "…"]) expect(JSON.stringify(card)).toContain(field);
  expect(JSON.stringify(card)).not.toContain("x".repeat(501));
  await f.close();
  const g = await f.reopen();
  const click = { messageId: "om_" + uuid, requestId: req.id, allow: via === "approve" };
  expect((await g.handlers.action({ ...click, openId: "stranger" })).toast.type).toBe("error");
  expect((await g.handlers.action({ ...click, messageId: "another-card", openId: "owner" })).toast.type).toBe("info");
  expect((await g.app.harness.snapshot(Requests, g.app.main.id, context))?.pending).toHaveProperty(req.id);
  if (via === "web") await answerUserPermission(g.app.main, { requestId: req.id, allow: true });
  else expect((await g.handlers.action({ ...click, openId: "owner" })).toast.type).toBe("success");
  await expect.poll(() => g.transport.updateCard.mock.calls.length).toBe(1);
  const [updated, contents] = g.transport.updateCard.mock.calls[0]!;
  expect(updated).toBe(click.messageId);
  expect(JSON.stringify(contents)).toContain(via === "web" ? "已在其他入口处理" : via === "approve" ? "已批准" : "已拒绝");
  expect(JSON.stringify(contents)).not.toContain("button");
  expect((await g.handlers.action({ ...click, openId: "owner" })).toast.type).toBe("info");
  await expect.poll(() => g.feed.snapshot().ledger.length).toBe(1);
  expect(g.app.demo.outbox).toHaveLength(via === "deny" ? 0 : 1);
  expect(g.transport.sendCard).not.toHaveBeenCalled();
});

it("keeps the most recent 500 message receipts across restart", async () => {
  const f = await setup();
  await f.pair();
  for (let i = 0; i < 501; i++) await f.send(String(i), "", { type: "image" });
  expect(JSON.parse(await readFile(join(f.dir, "feishu.json"), "utf8")).recent)
    .toEqual(Array.from({ length: 500 }, (_, i) => String(i + 1)));
  await f.close();
  const g = await f.reopen();
  await g.send("1", "", { type: "image" });
  await g.send("500", "", { type: "image" });
  expect(g.transport.sendText).not.toHaveBeenCalled();
  await g.send("0", "", { type: "image" });
  expect(g.transport.sendText).toHaveBeenCalledExactlyOnceWith("private", "目前只支持文字");
});

it("continues sending other cards after a failed send and recovers the winning decision after an update fails", async () => {
  const f = await setupApproval();
  await f.pair();
  let failedId: string | undefined;
  f.transport.sendCard.mockImplementation(async (_, _card, uuid) => {
    failedId ??= uuid;
    if (uuid === failedId) throw new Error("simulated send failure");
    return "om_" + uuid;
  });
  await submitMessage(f.app.main, "delegate");
  await expect.poll(() => failedId).toBeDefined();
  await submitMessage(f.app.main, "delegate");
  await expect.poll(() => f.feed.snapshot().pending.length).toBe(2);
  const requestId = f.feed.snapshot().pending[1]!.id;
  const sent = () => f.transport.sendCard.mock.calls.find(([, card]) => JSON.stringify(card).includes('"' + requestId + '"'));
  await expect.poll(sent).toBeDefined();
  const messageId = "om_" + sent()![2];
  f.transport.updateCard.mockRejectedValue(new Error("simulated update failure"));
  const result = await f.handlers.action({ openId: "owner", messageId, requestId, allow: true });
  expect(result.toast.type).toBe("success");
  await expect.poll(() => f.transport.updateCard.mock.calls.length).toBeGreaterThan(0);
  await f.close();
  const g = await f.reopen();
  await expect.poll(() => g.transport.updateCard.mock.calls.length).toBe(1);
  expect(g.transport.updateCard.mock.calls[0]![0]).toBe(messageId);
  expect(JSON.stringify(g.transport.updateCard.mock.calls[0]![1])).toContain("已批准");
  expect(g.transport.sendCard.mock.calls.map(([, , uuid]) => uuid)).toEqual([failedId]);
});

it("keeps capability requests addressed to the main assistant off the owner's cards", async () => {
  const f = await setup(({ model, messages }, res) => {
    if (model === "offline/task") return toolCall(res, "request_capability", { capability: "calendar", reason: "查看日程" });
    if (messages.at(-1)?.content?.endsWith("\ndelegate")) return toolCall(res, "dispatch_task",
      { brief: "查看日程", context: "fresh", permission: "restricted", allow: [] });
    say(res, "ack");
  });
  await f.pair();
  await submitMessage(f.app.main, "delegate");
  await expect.poll(() => f.feed.snapshot().pending[0]?.audience).toBe("main");
  await f.close();
  expect(f.transport.sendCard).not.toHaveBeenCalled();
});

it("delivers only unread now notifications to the paired owner and remembers IDs across restarts", async () => {
  const f = await setup();
  const notification = { at: f.clock.now, kind: "reminder", title: "提醒", body: "会议", source: "schedule", status: "unread" } as const;
  await f.app.main.commit(async tx => {
    const { entries } = await tx.doc(Notifications, f.app.main.id);
    entries.push({ ...notification, id: "first", level: "now" }, { ...notification, id: "quiet", level: "digest" },
      { ...notification, id: "mute", level: "silent" }, { ...notification, id: "old", level: "now", status: "read" });
  }, context);
  expect(f.transport.sendText).not.toHaveBeenCalled();
  await f.pair();
  await expect.poll(() => f.transport.sendText.mock.calls).toEqual([["private", "配对成功"], ["private", "提醒\n会议"]]);
  await updateNotification(f.app.main, "first", { feedback: "useful" });
  await f.close();
  const next = await f.reopen();
  await next.app.main.commit(async tx => {
    (await tx.doc(Notifications, next.app.main.id)).entries.unshift({ ...notification, body: "下班", id: "second", level: "now" });
  }, context);
  await updateNotification(next.app.main, "second", { status: "read" });
  await next.close();
  expect(next.transport.sendText.mock.calls).toEqual([["private", "提醒\n下班"]]);
  expect(f.gateway.requests).toHaveLength(0);
});

it("pushes a triaged external event to the paired owner exactly once", async () => {
  const f = await setup((_, res) => say(res, JSON.stringify({ level: "now", reason: "会议即将开始" })));
  await f.pair();
  await f.send("meeting", "会议改到十点", { chatType: "group" });
  await expect.poll(() => f.transport.sendText.mock.calls).toEqual([["private", "配对成功"], ["private", "会议改到十点\n会议即将开始"]]);
  await expect.poll(() => f.feed.snapshot().notifications).toMatchObject([
    { kind: "event", source: "feishu", ref: "meeting", level: "now", pushedAt: f.clock.now },
  ]);
  expect(f.feed.snapshot().timeline).toEqual([]);
  expect(f.gateway.requests).toMatchObject([{ model: "offline/task" }]);
  expect(f.gateway.requests[0]!.tools ?? []).toEqual([]);
  await f.close();
  const next = await f.reopen();
  expect(next.transport.sendText).not.toHaveBeenCalled();
});
