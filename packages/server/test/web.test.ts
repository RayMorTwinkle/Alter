import { once } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { get, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  context, createGatewayModels, gatewayConfig, openAlter, openNodeSqliteStorage, Leases, Tasks, type SurfaceEvent, type SurfaceState,
} from "@alter/core";
import { delta, fakeGateway, say, toolCall } from "../../core/test/fixtures/gateway.ts";
import { createWebServer } from "../src/server.ts";
import { createCalendarPlugin } from "@alter/plugin-calendar";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function setup(route: Parameters<typeof fakeGateway>[0] = (_, res) => say(res, "ok"), withCalendar = false) {
  const gateway = await fakeGateway(route);
  cleanup.push(gateway.close);
  const dir = await mkdtemp(join(tmpdir(), "alter-web-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const dist = join(dir, "dist");
  const config = gatewayConfig({ ALTER_LLM_BASE_URL: gateway.baseUrl, ALTER_LLM_API_KEY: "offline-key",
    ALTER_MAIN_MODEL: "offline/main", ALTER_TASK_MODEL: "offline/task", ALTER_DATA_DIR: dir });
  const { models, mainModel, taskModel } = await createGatewayModels(config);
  async function open() {
    const calendar = withCalendar ? createCalendarPlugin({ dataDir: dir, timeZone: "Asia/Shanghai" }) : undefined;
    const app = await openAlter(await openNodeSqliteStorage(join(dir, "main.sqlite")), models, mainModel, taskModel, {},
      { plugins: calendar ? [calendar] : [] });
    cleanup.push(() => app.harness.close(context));
    const web = await createWebServer(app, { password: "offline secret", dist, dataDir: dir, calendar });
    cleanup.push(web.close);
    web.server.listen(0, "127.0.0.1");
    await once(web.server, "listening");
    app.harness.resume();
    const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
    let cookie = "";
    function post(path: string, value?: unknown, type = "application/json") {
      return fetch(base + path, { method: "POST", headers: { "Content-Type": type, cookie }, body: JSON.stringify(value) });
    }
    async function login() {
      const response = await post("/api/login", { password: "offline secret" });
      expect(response.status).toBe(204);
      const header = response.headers.get("set-cookie")!;
      expect(header).toContain("HttpOnly");
      expect(header).toContain("SameSite=Strict");
      cookie = header.split(";")[0]!;
    }
    const read = (path: string) => fetch(base + path, { headers: { cookie } });
    return {
      app, post, read, login, base, dist, dir, sessionCookie: () => cookie,
      async close() { await web.close(); await app.harness.close(context); },
      async state(): Promise<SurfaceState> { return (await read("/api/state")).json(); },
    };
  }
  return { ...await open(), reopen: open };
}

type Event = SurfaceEvent | { event: "snapshot"; data: SurfaceState } | { event: "calendar"; data: unknown };

async function stream(read: (path: string) => Promise<Response>) {
  const response = await read("/api/events");
  expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: Event[] = [];
  const ended = (async () => {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let index: number;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (frame.startsWith(":")) continue;
        const [event, data] = frame.split("\n");
        events.push({ event: event!.slice(7) as Event["event"], data: JSON.parse(data!.slice(6)) });
      }
    }
  })();
  cleanup.push(async () => { await reader.cancel(); await ended; });
  const seen = async (match: (e: Event) => boolean) => { await expect.poll(() => events.some(match)).toBe(true); };
  await seen(e => e.event === "snapshot");
  expect(events[0]?.event).toBe("snapshot");
  return { events, seen, ended };
}

it("authenticates API requests, enforces JSON writes, and revokes the session including its open streams", async () => {
  const web = await setup();
  await expect(createWebServer(web.app, { password: "", dataDir: web.dir })).rejects.toThrow("ALTER_WEB_PASSWORD");
  for (const path of ["/api/state", "/api/events", "/api/usage", "/api/unknown"]) {
    const response = await web.read(path);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: expect.any(String) });
  }
  expect((await web.post("/api/login", { password: "wrong" })).status).toBe(401);
  expect((await web.post("/api/login", {}, "text/plain")).status).toBe(415);
  await web.login();
  expect((await web.post("/api/messages", { text: "no" }, "text/plain")).status).toBe(415);
  expect((await web.post("/api/messages", { text: " " })).status).toBe(400);
  const state = { timeline: [], tasks: [], pending: [], ledger: [], leases: [], busy: false };
  expect(await web.state()).toEqual(state);
  const feed = await stream(web.read);
  expect(feed.events[0]?.data).toEqual(state);
  expect((await web.post("/api/logout")).status).toBe(204);
  await feed.ended;
  expect((await web.read("/api/state")).status).toBe(401);
});

it("delivers live cumulative text, replays it on reconnect, and queues messages with stable echo IDs", async () => {
  let release!: ServerResponse;
  const web = await setup(({ messages }, res) => {
    if (messages.at(-1)?.content?.endsWith("\nfirst")) { release = res; delta(res, { content: "one" }); }
    else say(res, "second answer");
  });
  await web.login();
  const first = await stream(web.read);
  const sent = await web.post("/api/messages", { text: "first" });
  expect(sent.status).toBe(202);
  const { id } = await sent.json();
  await first.seen(e => e.event === "delta" && e.data.text === "one");
  const streamed = first.events.find(e => e.event === "delta")!;
  expect(first.events).toContainEqual({ event: "busy", data: { busy: true } });
  expect(first.events).toContainEqual({ event: "timeline", data: { id, at: expect.any(Number), kind: "user", text: "first" } });
  expect(await web.state()).toMatchObject({ busy: true });
  const next = await stream(web.read);
  await next.seen(e => e.event === "delta");
  expect(next.events[1]).toEqual(streamed);
  const queued = await web.post("/api/messages", { text: "next" });
  expect(queued.status).toBe(202);
  const second = await queued.json();
  await next.seen(e => e.event === "timeline" && e.data.id === second.id && e.data.kind === "user");
  expect(next.events).toContainEqual({ event: "timeline", data: { id: second.id, at: expect.any(Number), kind: "user", text: "next" } });
  delta(release, { content: " two" });
  await next.seen(e => e.event === "delta" && e.data.text === "one two");
  say(release, " three");
  await next.seen(e => e.event === "timeline" && e.data.text === "second answer");
  const final = { event: "timeline", data: { kind: "assistant", text: "one two three", id: streamed.data.id, at: expect.any(Number), model: "offline/main" } };
  expect(first.events).toContainEqual(final);
  expect(next.events.filter(e => e.event === "timeline" && e.data.id === second.id)).toHaveLength(1);
  await next.seen(e => e.event === "busy" && !e.data.busy);
  await web.app.main.waitForIdle(context);
  expect((await web.state()).timeline).toContainEqual(final.data);
  expect(await (await web.read("/api/usage")).json()).toMatchObject([{ model: "offline/main", calls: 2 }]);
});

const send = { tool: "outbox_send", capability: "outbox", arguments: { message: "hello" }, reason: "send greeting" };
const grant = { tool: "request_capability", capability: "calendar", arguments: { capability: "calendar", reason: "need dates" }, reason: "need dates" };
it.each([
  { permission: "auto", call: send, audience: "user" },
  { permission: "restricted", call: send, audience: "user" },
  { permission: "restricted", call: grant, audience: "main" },
])("observes a $permission task and routes $call.tool to $audience", async ({ permission, call, audience }) => {
  const web = await setup(({ model, messages }, res) => {
    const last = messages.at(-1)!;
    if (model === "offline/task") {
      if (last.role === "tool") return toolCall(res, "finish", { summary: "sent invitation", refs: [{ kind: "message", ref: "demo" }] });
      return toolCall(res, call.tool, call.arguments);
    }
    if (last.content?.endsWith("\ndelegate")) return toolCall(res, "dispatch_task", { brief: "send greeting", context: "fresh", permission, allow: [] });
    say(res, "ack");
  });
  await web.login();
  const feed = await stream(web.read);
  expect((await web.post("/api/messages", { text: "delegate" })).status).toBe(202);
  await feed.seen(e => e.event === "pending" && e.data.length === 1);
  const state = await web.state();
  const task = state.tasks[0]!;
  const request = state.pending[0]!;
  expect(task).toEqual({ taskId: expect.any(String), conversationId: expect.any(String), createdAt: expect.any(Number),
    context: "fresh", brief: "send greeting", permission, status: "running", allow: [], pending: [request] });
  expect(task.createdAt).toBeGreaterThan(0);
  expect(request).toEqual({ id: expect.any(String), taskId: task.taskId, audience,
    capability: call.capability, tool: call.tool, arguments: call.arguments, reason: call.reason, expiresAt: expect.any(Number) });
  expect(request.expiresAt).toBeGreaterThan(task.createdAt);
  expect(feed.events).toContainEqual({ event: "tasks", data: [task] });
  const decide = () => web.post("/api/permissions/" + request.id, { allow: true, note: "OK" });
  if (audience === "main") {
    expect((await decide()).status).toBe(409);
    expect((await web.state()).pending).toEqual([request]);
    return;
  }
  const decisions = await Promise.all([decide(), decide()]);
  expect(decisions.map(r => r.status).sort()).toEqual([204, 409]);
  await feed.seen(e => e.event === "timeline" && e.data.kind === "report" && e.data.taskId === task.taskId);
  await feed.seen(e => e.event === "ledger" && e.data[0]?.summary === "sent invitation");
  const updated = await web.state();
  expect(updated.ledger).toEqual([{ taskId: task.taskId, summary: "sent invitation", refs: [{ kind: "message", ref: "demo" }], at: expect.any(Number) }]);
  expect(updated.tasks[0]).toMatchObject({ status: "completed", pending: [] });
  expect(updated.pending).toEqual([]);
  expect(web.app.demo.outbox).toEqual(["hello"]);
  const transcript = await web.read(`/api/tasks/${task.taskId}/transcript`);
  expect(await transcript.json()).toMatchObject({ items: expect.arrayContaining([
    { kind: "user", text: "send greeting", at: expect.any(Number) },
    { kind: "tool_call", tool: "outbox_send", arguments: { message: "hello" }, at: expect.any(Number) },
    { kind: "tool_result", tool: "outbox_send", text: "Recorded in outbox", isError: false, at: expect.any(Number) },
  ]) });
  expect((await web.read("/api/tasks/missing/transcript")).status).toBe(404);
});

it("stops only the active turn and continues an already queued input", async () => {
  const web = await setup(({ messages }, res) => {
    if (messages.at(-1)?.content?.endsWith("\nstop me")) delta(res, { content: "partial" });
    else say(res, "continued");
  });
  await web.login();
  const feed = await stream(web.read);
  await web.post("/api/messages", { text: "stop me" });
  await feed.seen(e => e.event === "delta");
  await web.post("/api/messages", { text: "queued" });
  expect((await web.post("/api/stop")).status).toBe(204);
  await feed.seen(e => e.event === "timeline" && e.data.text === "continued");
  expect(feed.events).toContainEqual({ event: "timeline", data: expect.objectContaining({ kind: "assistant", text: "partial",
    id: feed.events.find(e => e.event === "delta")!.data.id }) });
});

it("serves the SPA and typed assets, rejecting raw, encoded and symlink traversal", async () => {
  const web = await setup();
  expect((await web.read("/")).status).toBe(404);
  await mkdir(web.dist);
  await writeFile(join(web.dist, "index.html"), "<main>Alter</main>");
  await writeFile(join(web.dist, "app.js"), "export {}");
  await writeFile(join(web.dir, "outside"), "outside build");
  await symlink(join(web.dir, "outside"), join(web.dist, "link"));
  for (const path of ["/", "/tasks/123?panel=1"]) {
    const response = await web.read(path);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe("<main>Alter</main>");
  }
  expect((await web.read("/app.js")).headers.get("content-type")).toContain("javascript");
  expect((await web.read("/link")).status).toBe(403);
  for (const path of ["/../outside", "/%2e%2e/outside", "/..%2foutside", "/%5c..%5coutside"]) {
    // fetch normalizes dot segments before sending them.
    const status = await new Promise(resolve => get(web.base, { path }, res => { res.resume(); resolve(res.statusCode); }));
    expect(status).toBe(400);
  }
  await web.login();
  expect((await web.read("/api/not-a-route")).status).toBe(404);
});

it("rebuilds the 200-item window, lease state and legacy task metadata from SQLite", async () => {
  const web = await setup(({ model, messages }, res) => {
    if (model === "offline/task") return toolCall(res, "finish", { summary: "ready", refs: [] });
    if (messages.at(-1)?.content?.endsWith("\ndelegate")) {
      return toolCall(res, "dispatch_task", { brief: "look", context: "fork", permission: "full", allow: [] });
    }
    say(res, "ack");
  });
  await web.login();
  await web.post("/api/messages", { text: "delegate" });
  await expect.poll(async () => (await web.state()).ledger.length).toBe(1);
  await web.app.main.waitForIdle(context);
  const task = (await web.state()).tasks[0]!;
  const transcript = await (await web.read(`/api/tasks/${task.taskId}/transcript`)).json();
  const brief = transcript.items.find((item: { text?: string }) => item.text === "look");
  const now = Date.now();
  await web.app.main.commit(async tx => {
    const old = (await tx.doc(Tasks, web.app.main.id)).byId[task.taskId]!;
    Reflect.deleteProperty(old, "context");
    Reflect.deleteProperty(old, "createdAt");
    const lease = await tx.doc(Leases, web.app.main.id);
    lease.turns = 9;
    lease.lastUsed.calendar = 7;
    for (let i = 0; i < 205; i++) {
      await tx.appendEntry(web.app.main.id, { kind: "alter.cli-input", model: [{ role: "user", content: String(i), timestamp: now + i }] });
    }
  }, context);
  const before = await web.state();
  expect(before.timeline).toHaveLength(200);
  expect(before.timeline[0]?.text).toBe("5");
  await web.close();
  const reopened = await web.reopen();
  expect((await fetch(reopened.base + "/api/state", { headers: { cookie: web.sessionCookie() } })).status).toBe(401);
  await reopened.login();
  const restored = await reopened.state();
  expect(restored.timeline).toEqual(before.timeline);
  expect(restored.tasks[0]).toEqual({ ...task, createdAt: brief.at, context: "fork" });
  expect(restored.leases).toEqual([{ capability: "calendar", idleTurns: 2, window: 30 }]);
});

it("serves the calendar agenda and pushes it when a leased calendar call changes it", async () => {
  const start = new Date(Date.now() + 86_400_000).toISOString();
  const web = await setup(({ messages }, res) => {
    const tools = messages.filter(m => m.role === "tool").length;
    if (messages.at(-1)?.content?.endsWith("\nbook")) return toolCall(res, "enable_tool", { capability: "calendar", reason: "book" });
    if (tools === 1) return toolCall(res, "calendar_create", { title: "周会", start, location: "A" });
    say(res, "booked");
  }, true);
  await web.login();
  expect(await (await web.read("/api/calendar")).json()).toEqual({ timeZone: "Asia/Shanghai", events: [] });
  const feed = await stream(web.read);
  await web.post("/api/messages", { text: "book" });
  await feed.seen(e => e.event === "calendar");
  const event = { id: expect.stringMatching(/^evt_/), title: "周会", start: Date.parse(start), end: Date.parse(start) + 3_600_000, allDay: false, location: "A" };
  expect(feed.events.find(e => e.event === "calendar")?.data).toEqual({ timeZone: "Asia/Shanghai", events: [event] });
  expect(await (await web.read("/api/calendar")).json()).toEqual({ timeZone: "Asia/Shanghai", events: [event] });
});

it("has no calendar endpoint without the calendar plugin", async () => {
  const web = await setup();
  await web.login();
  expect((await web.read("/api/calendar")).status).toBe(404);
});
