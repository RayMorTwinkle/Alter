import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { obj } from "@earendil-works/pi-schema";
import { contentText, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as say, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it, vi } from "vitest";
import { answerUserPermission, Audit, Requests } from "../src/broker.ts";
import { createCalendarPlugin } from "../../plugin-calendar/src/index.ts";
import { readTranscript, submitMessage } from "../src/timeline.ts";
import { createBrowserPlugin } from "../../plugin-browser/src/index.ts";
import { fakeEgo } from "../../plugin-browser/test/fake.ts";
import { createMailPlugin } from "../../plugin-mail/src/index.ts";
import { config as mailConfig, fakeMail, messageId, outgoing } from "../../plugin-mail/test/fake.ts";
import type { AlterPlugin } from "../src/capabilities.ts";
import { Events, openAlter } from "../src/main.ts";
import { context, defineTool, LiveDoc, MemoryStorage, reply, openNodeSqliteStorage, type Storage } from "../src/runtime.ts";
import { Taint } from "../src/taint.ts";
import { Ledger, Tasks, type Permission } from "../src/state.ts";
import { observeSurface, stopMainTurn } from "../src/observe.ts";
import { unescapeNewlines } from "../src/tasks.ts";

type Alter = Awaited<ReturnType<typeof openAlter>>;
type Route = (text: string, last: Message, history: Message[], offered: string[], signal?: AbortSignal) => AssistantMessage | Promise<AssistantMessage>;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

function call(name: string, args: Parameters<typeof fauxToolCall>[1]) {
  return say(fauxToolCall(name, args), { stopReason: "toolUse" });
}
function dispatch(brief: string, permission: Permission = "restricted", mode = "fresh") {
  return call("dispatch_task", { brief, permission, context: mode });
}
function finish(summary: string) {
  return call("finish", { summary, refs: [] });
}
async function open(route: Route, storage: Storage = new MemoryStorage(), plugins: AlterPlugin[] = [], approvalTimeoutMs?: number,
  clock: { timeZone?: string; now?: () => number } = {}, demos?: boolean) {
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
  faux.setResponses(Array.from({ length: 160 }, () => ({ messages }, options) => {
    const tools = new Set<string>();
    for (const msg of messages) {
      if (msg.role !== "system") continue;
      for (const tool of msg.toolsRemoved ?? []) tools.delete(tool.name);
      for (const tool of msg.toolsAdded ?? []) tools.add(tool.name);
    }
    const last = messages.findLast(msg => msg.role !== "system")!;
    const text = contentText(last.content);
    return route(last.role === "user" ? text.replace(/^\[当前时间 [^\n]*\]\n/, "") : text, last, messages, [...tools].sort(), options?.signal);
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await openAlter(storage, models, { provider: "faux", modelId: "faux-1" }, undefined, {}, { plugins, approvalTimeoutMs, demos, ...clock });
  cleanup.push(app.close);
  return app;
}
async function input(app: Alter, content: string) {
  const submission = await app.main.submit({ type: "input", content }, context);
  expect((await submission.wait(context)).status).toBe("done");
  await app.main.waitForIdle(context);
}
async function ledger(app: Alter) {
  return (await app.harness.snapshot(Ledger, app.main.id, context))?.entries ?? [];
}
async function incoming(app: Alter) {
  const page = await app.main.entries({ order: "ascending" }, 200, undefined, context);
  return page.items.flatMap(entry => (entry.model ?? []).flatMap(msg => msg.role === "user" ? [contentText(msg.content)] : []));
}

const memoryTools = ["memory_delete", "memory_save", "memory_search", "memory_update"];
const controls = ["dispatch_task", "enable_tool", ...memoryTools, "notify", "schedule_cancel", "schedule_create", "schedule_list", "task_cancel", "task_message", "task_status"];
const taskTools = ["calendar_create", "calendar_list", "calendar_update", "declare_permissions", "finish", ...memoryTools, "notes_read", "outbox_send"];

it("offers only real plugins when demos are off, so no simulated send exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-no-demos-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  let system = "";
  let taskSeen: string[] = [];
  const app = await open((text, last, messages, tools) => {
    if (text === "go") {
      system = messages.map(m => m.role === "system" ? JSON.stringify(m) : "").join("");
      return dispatch("look");
    }
    if (text === "look") { taskSeen = tools; return finish("done"); }
    return say("ok");
  }, new MemoryStorage(), [createCalendarPlugin({ dataDir: dir, timeZone: "Asia/Shanghai" })], undefined, {}, false);
  expect(app.capabilities.manifests.map(cap => cap.id)).toEqual(["memory", "calendar", "schedule"]);
  await input(app, "go");
  await expect.poll(async () => (await ledger(app)).length).toBe(1);
  expect(system).toContain("calendar（日历");
  expect(system).not.toMatch(/outbox|notes|示例/);
  expect(taskSeen).toEqual(["calendar_create", "calendar_delete", "calendar_list", "calendar_restore", "calendar_update", "declare_permissions", "finish", ...memoryTools]);
});

it("dispatches a fresh notes task and delivers its ledger summary to the main model", async () => {
  const seen: string[] = [];
  const app = await open((text, last, _, offered) => {
    if (text === "delegate") {
      seen.push(offered.join(","));
      return dispatch("read welcome", "restricted");
    }
    if (text === "read welcome") {
      seen.push(offered.join(","));
      return call("notes_read", { id: "welcome" });
    }
    if (last.role === "toolResult" && last.toolName === "notes_read") {
      return call("finish", { summary: text, refs: [{ kind: "note", ref: "welcome" }] });
    }
    if (text.includes(" finished: ")) seen.push(text);
    return say("OK");
  });
  await input(app, "delegate");
  await expect.poll(() => seen.some(line => line.endsWith("finished: Remember the planning meeting."))).toBe(true);
  expect(seen).toContain(controls.join(","));
  expect(seen).toContain(taskTools.join(","));
  expect(await ledger(app)).toEqual([{
    summary: "Remember the planning meeting.", refs: [{ kind: "note", ref: "welcome" }],
    taskId: expect.stringMatching(/^task-/), at: expect.any(Number),
  }]);
});

it("never asks the user twice in one task after a denial, while a new task asks again", async () => {
  const results: string[] = [];
  const app = await open((text, last) => {
    if (text === "delegate") return dispatch("send greeting", "restricted");
    if (text === "again") return dispatch("send again", "restricted");
    if (text === "send greeting" || text === "send again") return call("outbox_send", { message: "hello" });
    if (last.role === "toolResult" && last.toolName === "outbox_send") {
      results.push(text);
      // Retry once, as models sometimes do despite the denial message.
      return results.length === 1 ? call("outbox_send", { message: "hello again" }) : finish(text);
    }
    return say("OK");
  });
  await input(app, "delegate");
  const first = await parked(app);
  await answerUserPermission(app.main, { requestId: first.id, decision: "deny" });
  await expect.poll(async () => (await ledger(app)).length).toBe(1);
  expect(results[1]).toContain("already declined outbox_send");
  const audit = await app.harness.snapshot(Audit, app.main.id, context);
  expect(audit?.entries.filter(e => e.tool === "outbox_send").map(e => e.decision)).toEqual(["park", "deny", "deny"]);
  expect((await app.harness.snapshot(Requests, app.main.id, context))!.pending).toEqual({});

  await input(app, "again");
  const second = await parked(app);
  expect(second).toMatchObject({ audience: "user", tool: "outbox_send" });
});

it("keeps asking for each send after an approval", async () => {
  let sends = 0;
  const app = await open((text, last) => {
    if (text === "delegate") return dispatch("send twice", "restricted");
    if (text === "send twice") return call("outbox_send", { message: "one" });
    if (last.role === "toolResult" && last.toolName === "outbox_send") {
      return ++sends === 1 ? call("outbox_send", { message: "two" }) : finish("sent");
    }
    return say("OK");
  });
  await input(app, "delegate");
  const first = await parked(app);
  await answerUserPermission(app.main, { requestId: first.id, decision: "once" });
  await expect.poll(async () => Object.values((await app.harness.snapshot(Requests, app.main.id, context))?.pending ?? {})
    .filter(r => r.audience === "user" && r.id !== first.id).length).toBe(1);
  expect(app.demo.outbox).toEqual(["one"]);
});

it.each([true, false])("routes a restricted send to the user, allow=%s", async allow => {
  let sendResult = "";
  const app = await open((text, last) => {
    if (text === "delegate") return dispatch("send greeting", "restricted");
    if (text === "send greeting") return call("outbox_send", { message: "hello" });
    if (last.role === "toolResult" && last.toolName === "outbox_send") {
      sendResult = text;
      return finish(text);
    }
    return say("OK");
  });
  await input(app, "delegate");
  const request = await parked(app);
  expect(request.audience).toBe("user");
  await answerUserPermission(app.main, { requestId: request.id, decision: allow ? "once" : "deny", note: "keep it private" });
  await expect.poll(async () => (await ledger(app)).length).toBe(1);
  expect((await incoming(app)).filter(line => line.startsWith("permission request "))).toEqual([]);
  expect(sendResult).toContain(allow ? "Recorded in outbox" : "keep it private");
  expect(app.demo.outbox).toEqual(allow ? ["hello"] : []);
  const audit = await app.harness.snapshot(Audit, app.main.id, context);
  expect(audit?.entries.filter(e => e.tool === "outbox_send").map(e => e.decision)).toEqual(["park", allow ? "allow" : "deny"]);
});

async function parked(app: Alter) {
  const find = async () => {
    const requests = await app.harness.snapshot(Requests, app.main.id, context);
    const request = Object.values(requests?.pending ?? {})[0];
    if (!request) return;
    const task = (await app.harness.snapshot(Tasks, app.main.id, context))?.byId[request.taskId];
    const conversation = request.taskId === "main" ? app.main.id : task?.conversationId;
    if (!conversation) return;
    const live = await app.harness.snapshot(LiveDoc, conversation, context);
    if (live?.tools?.some(slot => slot.taskId === request.toolTask && slot.status === "sleeping")) return request;
  };
  await expect.poll(find).toBeDefined();
  return (await find())!;
}

it("resumes a SQLite approval after closing and admits exactly one report across reopens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-m0-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const reopen = () => openNodeSqliteStorage(join(dir, "main.sqlite"));
  const route: Route = (text, last) => {
    if (text === "delegate") return dispatch("record after restart");
    if (text === "record after restart") return call("outbox_send", { message: "survived" });
    if (last.role === "toolResult" && last.toolName === "outbox_send") return finish(text);
    return say("acknowledged");
  };
  const first = await open(route, await reopen());
  await input(first, "delegate");
  const { id: requestId, expiresAt } = await parked(first);
  await first.main.waitForIdle(context);
  expect(first.demo.outbox).toEqual([]);
  await first.harness.close(context);

  const second = await open(route, await reopen(), [], 60_000);
  second.harness.resume();
  expect(await parked(second)).toMatchObject({ id: requestId, expiresAt });
  await answerUserPermission(second.main, { requestId, decision: "once" });
  await expect.poll(async () => (await ledger(second)).length).toBe(1);
  await second.main.waitForIdle(context);
  expect(second.demo.outbox).toEqual(["survived"]);
  await second.harness.close(context);

  const third = await open(route, await reopen());
  third.harness.resume();
  await third.main.waitForIdle(context);
  expect((await incoming(third)).filter(text => text.endsWith("finished: Recorded in outbox"))).toHaveLength(1);
  expect(await ledger(third)).toHaveLength(1);
});

it("expires an unanswered user approval and notifies main once", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const tool = "outbox_send";
    const notifications: string[] = [];
    const app = await open((text, last) => {
      if (text === "delegate") return dispatch("work");
      if (text === "work") return call(tool, { message: "hello" });
      if (last.role === "toolResult" && last.toolName === tool) return finish(text);
      if (text.startsWith("Notify the user:")) notifications.push(text);
      return say("OK");
    });
    await input(app, "delegate");
    const request = await parked(app);
    expect(request).toMatchObject({ audience: "user", expiresAt: now + 86_400_000 });
    clock.mockReturnValue(request.expiresAt);
    expect((await answerUserPermission(app.main, { requestId: request.id, decision: "once" })).isError).toBe(true);
    app.harness.resume();
    await expect.poll(async () => (await ledger(app)).map(e => e.summary)).toEqual([expect.stringContaining("Approval expired without a decision")]);
    await app.main.waitForIdle(context);
    expect(notifications).toEqual([`Notify the user: task ${request.taskId}, request ${request.id} (${tool}): Approval expired without a decision`]);
    expect(app.demo.outbox).toEqual([]);
    expect((await app.harness.snapshot(Requests, app.main.id, context))?.pending).toEqual({});
    expect((await app.harness.snapshot(Audit, app.main.id, context))?.entries.filter(e => e.tool === tool).map(e => e.decision))
      .toEqual(["park", "deny"]);
  } finally { clock.mockRestore(); }
});

it("recovers a parked call after SIGKILL with no graceful close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-crash-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const database = join(dir, "main.sqlite");
  const worker = fork(new URL("./fixtures/crash-worker.ts", import.meta.url), [database], { execArgv: [] });
  const exited = once(worker, "exit");
  cleanup.push(async () => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    await exited;
  });
  const [requestId] = await Promise.race([
    once(worker, "message"),
    exited.then(([code, signal]) => { throw new Error(`Worker exited before parking: ${code ?? signal}`); }),
  ]);
  worker.kill("SIGKILL");
  expect(await exited).toEqual([null, "SIGKILL"]);

  const app = await open((text, last) =>
    last.role === "toolResult" && last.toolName === "outbox_send" ? finish(text) : say("OK"),
    await openNodeSqliteStorage(database));
  app.harness.resume();
  expect((await parked(app)).id).toBe(requestId);
  await answerUserPermission(app.main, { requestId, decision: "once" });
  await expect.poll(async () => (await ledger(app)).length).toBe(1);
  await app.main.waitForIdle(context);
  expect(app.demo.outbox).toEqual(["recovered"]);
  expect((await incoming(app)).filter(text => text.endsWith("finished: Recorded in outbox"))).toHaveLength(1);
});

it("renews the calendar lease on use and expires it at thirty idle turns", async () => {
  let eventId = "";
  const offers = new Map<string, string[]>();
  let refused = "";
  const app = await open((text, last, _, offered) => {
    if (last.role === "user") offers.set(text, offered);
    if (text === "calendar please") return call("enable_tool", { capability: "calendar", reason: "manage schedule" });
    if (text === "create") return call("calendar_create", { title: "meeting" });
    if (text === "update") return call("calendar_update", { id: eventId, title: "review" });
    if (text === "outbox please") return call("enable_tool", { capability: "outbox", reason: "send" });
    if (last.role === "toolResult" && last.toolName === "calendar_create") eventId = text;
    if (last.role === "toolResult" && last.isError) refused = text;
    return say("OK");
  });
  await input(app, "calendar please");
  await input(app, "create");
  for (let i = 1; i <= 29; i++) await input(app, `before update ${i}`);
  await input(app, "update");
  expect(app.demo.calendar.get(eventId)).toBe("review");
  for (let i = 1; i <= 30; i++) await input(app, `after update ${i}`);
  await input(app, "outbox please");
  await input(app, "final");
  const withCalendar = [...controls, "calendar_create", "calendar_list", "calendar_update"].sort();
  expect(offers.get("calendar please")).toEqual(controls);
  expect(offers.get("update")).toEqual(withCalendar);
  expect(offers.get("after update 30")).toEqual(withCalendar);
  expect(offers.get("outbox please")).toEqual(controls);
  expect(offers.get("final")).toEqual(controls);
  expect(refused).toContain("not leasable");
});

it("allows auto local writes and accepts only a host decision for an external send", async () => {
  let requestId = "";
  let mainResult = "";
  let status = "";
  const app = await open((text, last) => {
    if (text === "delegate") return dispatch("schedule and notify", "auto");
    if (text === "schedule and notify") return call("calendar_create", { title: "meeting" });
    if (last.role === "toolResult" && last.toolName === "calendar_create") return call("outbox_send", { message: "invitation" });
    if (text.startsWith("check task-")) return call("task_status", { taskId: text.slice(6) });
    if (last.role === "toolResult" && last.toolName === "task_status") status = text;
    if (text === "approve as main") return call("answer_permission_request", { requestId, allow: true });
    if (last.role === "toolResult" && last.toolName === "answer_permission_request") mainResult = text;
    if (last.role === "toolResult" && last.toolName === "outbox_send") return finish(text);
    return say("OK");
  });
  await input(app, "delegate");
  const request = await parked(app);
  requestId = request.id;
  expect(request.audience).toBe("user");
  expect([...app.demo.calendar.values()]).toEqual(["meeting"]);
  await input(app, `check ${request.taskId}`);
  expect(JSON.parse(status)).toMatchObject({ taskId: request.taskId, status: "running", pending: [{ id: request.id, audience: "user" }] });
  expect(JSON.parse(status).pending[0].remainingMs).toBeGreaterThan(0);
  expect(JSON.parse(status).pending[0].remainingMs).toBeLessThanOrEqual(86_400_000);
  await input(app, "approve as main");
  expect(mainResult).toContain("not available");
  expect(app.demo.outbox).toEqual([]);
  expect((await answerUserPermission(app.main, { requestId, decision: "once" })).isError).toBe(false);
  await expect.poll(async () => (await ledger(app)).length).toBe(1);
  expect(app.demo.outbox).toEqual(["invitation"]);
  const audit = (await app.harness.snapshot(Audit, app.main.id, context))!.entries;
  expect(audit.map(({ action, effect, decision }) => [action, effect, decision])).toEqual([
    ["create", "write-local", "allow"], ["send", "external-send", "park"],
    ["send", "external-send", "allow"], ["finish", "write-local", "allow"],
  ]);
});

it.each([true, false])("bounds reminders and only records finish (cooperative=%s)", async cooperative => {
  let reminders = 0;
  const app = await open((text) => {
    if (text === "delegate") return dispatch("do the work");
    if (text === "do the work") return say("I am done.");
    if (text.startsWith("Complete the task by calling finish")) {
      reminders++;
      return cooperative ? finish("verified summary") : say("I am still done.");
    }
    return say("OK");
  });
  await input(app, "delegate");
  await expect.poll(async () => (await incoming(app)).filter(t => /task task-\d+ (finished|failed):/.test(t)).length).toBe(1);
  expect(reminders).toBe(cooperative ? 1 : 3);
  expect((await ledger(app)).map(e => e.summary)).toEqual(cooperative ? ["verified summary"] : []);
  expect(Object.values((await app.harness.snapshot(Tasks, app.main.id, context))!.byId)[0]?.status)
    .toBe(cooperative ? "completed" : "failed");
});

it.each(["fork", "fresh"])("gives a %s task the correct conversation history", async mode => {
  const fact = "The project codename is Juniper.";
  const app = await open((text, _, messages) => {
    if (text === "delegate") return dispatch("recall the codename", "restricted", mode);
    if (text === "recall the codename") {
      return finish(messages.some(msg => msg.role === "user" && contentText(msg.content) === fact) ? "Juniper" : "unknown");
    }
    return say("OK");
  });
  await input(app, fact);
  await input(app, "delegate");
  await expect.poll(async () => (await ledger(app)).map(e => e.summary)).toEqual([mode === "fork" ? "Juniper" : "unknown"]);
});

it("clears outstanding requests when the host stops a parked task", async () => {
  const app = await open(text => {
    if (text === "delegate") return dispatch("send", "auto");
    if (text === "send") return call("outbox_send", { message: "old invitation" });
    return say("OK");
  });
  await input(app, "delegate");
  const request = await parked(app);
  await app.main.abort(context, { background: true });
  expect((await app.harness.snapshot(Tasks, app.main.id, context))?.byId[request.taskId]?.status).toBe("failed");
  expect((await app.harness.snapshot(Requests, app.main.id, context))?.pending).toEqual({});
  expect(await ledger(app)).toEqual([]);
  expect(app.demo.outbox).toEqual([]);
});

it("requires references in finish before reporting success", async () => {
  let rejected = false;
  const app = await open((text, last) => {
    if (text === "delegate") return dispatch("report with refs");
    if (text === "report with refs") return call("finish", { summary: "premature" });
    if (last.role === "toolResult" && last.toolName === "finish") {
      rejected = last.isError;
      return finish("validated");
    }
    return say("OK");
  });
  await input(app, "delegate");
  await expect.poll(async () => (await ledger(app)).map(e => e.summary)).toEqual(["validated"]);
  expect(rejected).toBe(true);
  expect((await incoming(app)).filter(line => line.includes(" finished: "))).toHaveLength(1);
});

it("parks the installed mail connector's auto send before SMTP and resumes it on user approval", async () => {
  const mail = fakeMail();
  const plugin = createMailPlugin(mailConfig, mail.clients);
  let leaseResult = "";
  const app = await open((text, last, _, offered) => {
    if (text === "try lease") return call("enable_tool", { capability: "mail", reason: "read inbox" });
    if (last.role === "toolResult" && last.toolName === "enable_tool") leaseResult = text;
    if (text === "delegate") {
      expect(offered).not.toContain("mail_send");
      return dispatch("send mail", "auto");
    }
    if (text === "send mail") {
      expect(offered).toContain("mail_send");
      return call("mail_send", outgoing);
    }
    if (last.role === "toolResult" && last.toolName === "mail_send") return finish(text);
    return say("OK");
  }, new MemoryStorage(), [plugin]);
  await input(app, "try lease");
  expect(leaseResult).toContain("not leasable");
  await input(app, "delegate");
  const request = await parked(app);
  expect(request).toMatchObject({ audience: "user", capability: "mail", tool: "mail_send" });
  expect(mail.clients.smtp).not.toHaveBeenCalled();
  await answerUserPermission(app.main, { requestId: request.id, decision: "once" });
  await expect.poll(async () => (await ledger(app)).length).toBe(1);
  expect([...mail.sent.keys()]).toEqual([(await ledger(app))[0]!.summary]);
  expect(mail.clients.smtp).toHaveBeenCalledTimes(1);
  expect((await app.harness.snapshot(Audit, app.main.id, context))?.entries.filter(e => e.tool === "mail_send")
    .map(e => [e.effect, e.decision])).toEqual([["external-send", "park"], ["external-send", "allow"]]);
});

it.each(["restricted", "full"] as const)("opens and clicks, then parks a tainted browser fill in %s mode", async permission => {
  const ego = fakeEgo();
  const app = await open((text, last) => {
    if (text === "delegate") return dispatch("browse", permission);
    if (text === "browse") return call("browser_open", { url: "https://example.test/" });
    if (last.role === "toolResult") {
      if (last.toolName === "browser_open") return call("browser_click", { target: "@21" });
      if (last.toolName === "browser_click") return call("browser_fill", { target: "@22", text: "hello" });
      if (last.toolName === "browser_fill") return finish("browsed");
    }
    return say("OK");
  }, new MemoryStorage(), [createBrowserPlugin({ runner: ego.runner })]);
  await input(app, "delegate");
  const request = await parked(app);
  expect(request).toMatchObject({ audience: "user", tool: "browser_fill", tainted: true,
    taint: { capability: "browser", source: "browser_open" } });
  expect(ego.page.goto).toHaveBeenCalledOnce();
  expect(ego.page.click).toHaveBeenCalledOnce();
  expect(ego.page.fill).not.toHaveBeenCalled();
  await answerUserPermission(app.main, { requestId: request.id, decision: "once" });
  await expect.poll(() => ego.finish.mock.calls.length).toBe(1);
  expect(ego.page.fill).toHaveBeenCalledWith("@22", "hello");
  expect(ego.spaces.size).toBe(0);
  expect((await ledger(app))[0]?.summary).toBe("browsed");
});

it("aborts a parked task even when plugin cleanup fails", async () => {
  const plugin: AlterPlugin = {
    capability: { id: "fixture", mainLeasable: false, actions: [{ name: "read", effect: "read" }] },
    tools: [defineTool({ name: "fixture_read", description: "Read", parameters: obj({}), execute: async () => reply("ok") })],
    onTaskEnd: async () => { throw new Error("browser gone"); },
  };
  const app = await open(text => {
    if (text === "delegate") return dispatch("send", "auto");
    if (text === "send") return call("outbox_send", { message: "hello" });
    return say("OK");
  }, new MemoryStorage(), [plugin]);
  await input(app, "delegate");
  const request = await parked(app);
  const owner = await app.main.commit(async tx => {
    const task = (await tx.doc(Tasks, app.main.id)).byId[request.taskId]!;
    return (await tx.conversation(task.conversationId))!.owner!.taskId;
  }, context);
  await app.harness.abortTask(owner, context);
  const ended = await app.harness.waitForTask(owner, context);
  expect(ended?.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
  expect((await app.harness.snapshot(Tasks, app.main.id, context))?.byId[request.taskId]?.status).toBe("failed");
});

it("closes the browser space when a parked task is aborted", async () => {
  const ego = fakeEgo();
  const app = await open((text, last) => {
    if (text === "delegate") return dispatch("browse", "restricted");
    if (text === "browse") return call("browser_open", { url: "https://example.test/" });
    if (last.role === "toolResult" && last.toolName === "browser_open") return call("browser_press", { key: "Enter" });
    return say("OK");
  }, new MemoryStorage(), [createBrowserPlugin({ runner: ego.runner })]);
  await input(app, "delegate");
  const request = await parked(app);
  const owner = await app.main.commit(async tx => {
    const task = (await tx.doc(Tasks, app.main.id)).byId[request.taskId]!;
    return (await tx.conversation(task.conversationId))!.owner!.taskId;
  }, context);
  await app.harness.abortTask(owner, context);
  await app.harness.waitForTask(owner, context);
  expect(ego.spaces.size).toBe(0);
  expect(ego.page.keyboard.press).not.toHaveBeenCalled();
});

it("caps plugin events on main and lets an event source flush before harness close", async () => {
  let stopped = 0;
  const app = await open(() => say("OK"), new MemoryStorage(), [{
    capability: { id: "fixture", mainLeasable: false, actions: [] }, tools: [],
    async start(host) {
      const emit = (i: number) => host.emit({ source: "fixture", kind: "received", summary: "external content",
        ref: String(i), at: i, untrusted: true });
      for (let i = 0; i <= 500; i++) await emit(i);
      return async () => { await emit(501); stopped++; };
    },
  }]);
  const doc = await app.harness.snapshot(Events, app.main.id, context);
  expect(doc?.entries).toHaveLength(500);
  expect(doc?.entries[0]?.ref).toBe("1");
  expect(doc?.entries.at(-1)).toMatchObject({ ref: "500", untrusted: true });
  expect(await incoming(app)).toEqual([]);
  await Promise.all([app.close(), app.close()]);
  expect(stopped).toBe(1);
});

it("replays an interrupted mail_send from SQLite and finds the server copy before SMTP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-mail-crash-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const database = join(dir, "main.sqlite");
  const worker = fork(new URL("./fixtures/mail-crash-worker.ts", import.meta.url), [database], { execArgv: [] });
  const exited = once(worker, "exit");
  cleanup.push(async () => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    await exited;
  });
  const [encoded] = await Promise.race([
    once(worker, "message"),
    exited.then(() => { throw new Error("Worker exited before fake SMTP accepted the message"); }),
  ]);
  worker.kill("SIGKILL");
  expect(await exited).toEqual([null, "SIGKILL"]);

  const raw = Buffer.from(encoded, "base64");
  const id = messageId(raw);
  const mail = fakeMail();
  mail.sent.set(id, raw);
  const app = await open((text, last) => last.role === "toolResult" && last.toolName === "mail_send" ? finish(text) : say("OK"),
    await openNodeSqliteStorage(database), [createMailPlugin(mailConfig, mail.clients)]);
  app.harness.resume();
  await expect.poll(async () => (await ledger(app)).map(entry => entry.summary)).toEqual([id]);
  expect(mail.sessions.find(session => session.selected === "custom/sent")?.search)
    .toHaveBeenCalledWith({ header: { "Message-ID": id } }, { uid: true, strict: true });
  expect(mail.clients.smtp).not.toHaveBeenCalled();
  expect(mail.sessions.every(session => !session.append.mock.calls.length)).toBe(true);
});

it("leases a declared plugin only in the harness where it is installed", async () => {
  const capability = { id: "clock", mainLeasable: true, actions: [{ name: "read", effect: "read" as const }] };
  const plugin = { capability, tools: [defineTool({
    name: "clock_read", description: "Test clock", parameters: obj({}), execute: async () => reply("noon"),
  })] };
  const results: string[] = [];
  const route: Route = (text, last, _, offered) => {
    if (text === "clock please") return call("enable_tool", { capability: "clock", reason: "check time" });
    if (text === "time" && offered.includes("clock_read")) return call("clock_read", {});
    if (text === "read clock") return call("clock_read", {});
    if (last.role === "toolResult") results.push(text);
    return say("OK");
  };
  const installed = await open(route, new MemoryStorage(), [plugin]);
  const plain = await open(route);
  await input(installed, "clock please");
  await input(installed, "time");
  await input(plain, "clock please");
  await input(plain, "read clock");
  expect(results).toEqual(["Enabled clock", "noon", "Capability is not leasable", expect.stringContaining("not available")]);
});

it("unescapes newlines only when a summary has none", () => {
  expect(unescapeNewlines("a\\n\\nb")).toBe("a\n\nb");
  expect(unescapeNewlines("a\nuse \\n in code")).toBe("a\nuse \\n in code");
  expect(unescapeNewlines("plain")).toBe("plain");
});

function externalPlugin() {
  const actions = [{ name: "send", effect: "external-send" }, { name: "delete", effect: "irreversible" },
    { name: "run", effect: "unknown" }] as const;
  const execute = vi.fn(async () => reply("executed"));
  const plugin: AlterPlugin = {
    capability: { id: "remote", mainLeasable: true, actions: [{ name: "read", effect: "read" }, ...actions] },
    tools: [
      defineTool({ name: "remote_read", description: "Read external text", parameters: obj({}),
        execute: async () => ({ ...reply("external text"), details: { untrusted: true } }) }),
      ...actions.map(({ name }) => defineTool({ name: `remote_${name}`, description: name, parameters: obj({}), execute })),
    ],
  };
  return { plugin, execute };
}

it.each(["send", "delete", "run"])("requires user approval for a tainted full task's remote_%s", async action => {
  const { plugin, execute } = externalPlugin();
  const tool = "remote_" + action;
  const app = await open((text, last) => {
    if (text === "delegate") return dispatch("read then act", "full");
    if (text === "read then act") return call("remote_read", {});
    if (last.role === "toolResult") {
      if (last.toolName === "remote_read") return call(tool, {});
      if (last.toolName === tool) return finish(text);
    }
    return say("OK");
  }, new MemoryStorage(), [plugin]);
  const surface = await observeSurface(app, () => {});
  cleanup.push(async () => surface.detach());
  await input(app, "delegate");
  const request = await parked(app);
  expect(request).toMatchObject({ audience: "user", tool, tainted: true,
    taint: { source: "remote_read", capability: "remote", at: expect.any(Number) } });
  expect(surface.snapshot().pending).toMatchObject([{ id: request.id, tainted: true, taint: request.taint }]);
  expect(surface.snapshot().tasks[0]?.pending).toEqual(surface.snapshot().pending);
  expect(execute).not.toHaveBeenCalled();
  expect((await app.harness.snapshot(Audit, app.main.id, context))?.entries).toContainEqual(
    expect.objectContaining({ tool, decision: "park", tainted: true }));
  await answerUserPermission(app.main, { requestId: request.id, decision: "once" });
  await expect.poll(async () => (await ledger(app)).map(e => e.summary)).toEqual(["executed"]);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("propagates a mail report to main and into both fork and fresh tasks across SQLite reopens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-taint-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const storage = () => openNodeSqliteStorage(join(dir, "main.sqlite"));
  const plugin = createMailPlugin(mailConfig, fakeMail().clients);
  const route: Route = (text, last) => {
    if (text === "read mail") return dispatch("search mail", "full");
    if (text === "search mail") return call("mail_search", {});
    if (last.role === "toolResult" && last.toolName === "mail_search") return finish("mail report");
    if (text === "fork" || text === "fresh") return dispatch("send report", "full", text);
    if (text === "send report") return call("outbox_send", { message: "report" });
    if (last.role === "toolResult" && last.toolName === "outbox_send") return finish(text);
    return say("OK");
  };
  const first = await open(route, await storage(), [plugin]);
  await input(first, "read mail");
  await expect.poll(async () => (await ledger(first)).length).toBe(1);
  await first.main.waitForIdle(context);
  const source = (await first.harness.snapshot(Taint, first.main.id, context))?.first;
  expect(source).toEqual({ source: "mail_search", capability: "mail", at: expect.any(Number) });
  await input(first, "fork");
  const forked = await parked(first);
  expect(forked).toMatchObject({ audience: "user", tainted: true, taint: source });
  await first.close();
  const app = await open(route, await storage(), [plugin]);
  app.harness.resume();
  const tasks = (await app.harness.snapshot(Tasks, app.main.id, context))!.byId;
  for (const id of [app.main.id, ...Object.values(tasks).map(task => task.conversationId)]) {
    expect((await app.harness.snapshot(Taint, id, context))?.first).toEqual(source);
  }
  expect(await parked(app)).toEqual(forked);
  await answerUserPermission(app.main, { requestId: forked.id, decision: "deny" });
  await expect.poll(async () => (await ledger(app)).length).toBe(2);
  await input(app, "fresh");
  expect(await parked(app)).toMatchObject({ audience: "user", tool: "outbox_send", tainted: true, taint: source });
  expect(app.demo.outbox).toEqual([]);
});

it("gates a leased main tool after an external result, including when the user stops the turn", async () => {
  const { plugin, execute } = externalPlugin();
  const app = await open(text => {
    if (text === "lease") return call("enable_tool", { capability: "remote", reason: "use remote" });
    if (text === "read") return call("remote_read", {});
    if (text === "send") return call("remote_send", {});
    return say("OK");
  }, new MemoryStorage(), [plugin]);
  await input(app, "lease");
  await input(app, "send");
  expect(execute).toHaveBeenCalledTimes(1);
  await input(app, "read");
  await app.main.submit({ type: "input", content: "send" }, context);
  const req = await parked(app);
  expect(req).toMatchObject({ taskId: "main", audience: "user", tool: "remote_send", tainted: true,
    taint: { source: "remote_read" } });
  expect(execute).toHaveBeenCalledTimes(1);
  await answerUserPermission(app.main, { requestId: req.id, decision: "once" });
  await app.main.waitForIdle(context);
  expect(execute).toHaveBeenCalledTimes(2);
  await app.main.submit({ type: "input", content: "send" }, context);
  await parked(app);
  await stopMainTurn(app);
  expect((await app.harness.snapshot(Requests, app.main.id, context))?.pending).toEqual({});
  expect(execute).toHaveBeenCalledTimes(2);
});

it("withholds an external result if its taint cannot be persisted", async () => {
  const observed: string[] = [];
  const plugin: AlterPlugin = {
    capability: { id: "fixture", mainLeasable: false, actions: [{ name: "read", effect: "read" }] },
    tools: [defineTool({ name: "fixture_read", description: "Read external data", parameters: obj({}), execute: async () => {
      vi.spyOn(app.main, "commit").mockRejectedValueOnce(new Error("storage unavailable"));
      return { ...reply("untracked content"), details: { untrusted: true } };
    } })],
  };
  const app: Alter = await open((text, last) => {
    if (text === "delegate") return dispatch("read", "full");
    if (text === "read") return call("fixture_read", {});
    if (last.role === "toolResult" && last.toolName === "fixture_read") {
      observed.push(text);
      return finish(text);
    }
    return say("OK");
  }, new MemoryStorage(), [plugin]);
  await input(app, "delegate");
  await expect.poll(async () => (await ledger(app)).length).toBe(1);
  expect(observed).toEqual(["External content withheld because its source could not be recorded"]);
});

it("leases only the installed calendar tools and creates a timed event in the same main turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-calendar-lease-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const plugin = createCalendarPlugin({ dataDir: dir, timeZone: "Asia/Shanghai" });
  let created = "";
  let leased: string[] = [];
  const app = await open((text, last, _, offered) => {
    if (text === "schedule") return call("enable_tool", { capability: "calendar", reason: "schedule meeting" });
    if (last.role === "toolResult" && last.toolName === "enable_tool") {
      leased = offered.filter(name => name.startsWith("calendar_"));
      return call("calendar_create", { title: "站会", start: "2026-11-23T15:00", location: "A" });
    }
    if (last.role === "toolResult" && last.toolName === "calendar_create") created = text;
    return say("OK");
  }, new MemoryStorage(), [plugin]);
  await submitMessage(app.main, "schedule");
  await app.main.waitForIdle(context);
  expect(app.demo.tools.map(t => t.name)).toEqual(["notes_read", "outbox_send"]);
  expect(app.capabilities.manifests.filter(cap => cap.id === "calendar")).toEqual([plugin.capability]);
  expect(leased).toEqual(plugin.tools.map(t => t.name).sort());
  const agent = await app.main.agent(context);
  expect(agent.tools.map(t => t.name).sort()).toEqual([...controls, ...leased].sort());
  expect(JSON.parse(created).event).toMatchObject({ title: "站会", start: "2026-11-23T15:00:00.000+08:00", location: "A" });
  expect(app.demo.calendar.size).toBe(0);
});

it("stamps each model input at submission or dispatch and preserves the original surface text", async () => {
  let at = Date.parse("2026-11-22T03:50Z");
  const raw = "[当前时间 用户原文]\n请派单";
  const seen: string[] = [];
  const app = await open((_, last) => {
    if (last.role === "user") {
      const content = contentText(last.content);
      seen.push(content);
      if (content.endsWith(raw)) {
        at += 60_000;
        return dispatch("查日历");
      }
      if (content.endsWith("查日历")) return finish("已查");
    }
    return say("OK");
  }, new MemoryStorage(), [], undefined, { timeZone: "Asia/Shanghai", now: () => at });
  const surface = await observeSurface(app, () => {});
  cleanup.push(async () => surface.detach());
  const id = await submitMessage(app.main, raw);
  await expect.poll(async () => (await ledger(app)).length).toBe(1);
  await app.main.waitForIdle(context);
  await submitMessage(app.main, "下一条");
  await app.main.waitForIdle(context);
  expect(seen).toContain("[当前时间 2026-11-22 周日 11:50 Asia/Shanghai]\n" + raw);
  expect(seen).toContain("[当前时间 2026-11-22 周日 11:51 Asia/Shanghai]\n查日历");
  expect(seen).toContain("[当前时间 2026-11-22 周日 11:51 Asia/Shanghai]\n下一条");
  expect(surface.snapshot().timeline.find(item => item.id === id)?.text).toBe(raw);
  const [task] = Object.values((await app.harness.snapshot(Tasks, app.main.id, context))!.byId);
  const history = await observeSurface(app, () => {});
  cleanup.push(async () => history.detach());
  expect(history.snapshot().timeline.find(item => item.id === id)?.text).toBe(raw);
  const child = await app.harness.conversation(task!.conversationId, context);
  expect(await readTranscript(child!)).toContainEqual({ kind: "user", text: "查日历", at: expect.any(Number) });
});

it("adds only profiles and current or pending goals between the clock and the original user text", async () => {
  let at = 100;
  const app = await open(() => say("OK"), new MemoryStorage(), [], undefined, { now: () => at }, false);
  const { memory } = app;
  expect(memory.summary()).toBe("");
  const old = memory.save({ kind: "profile", text: "旧画像" });
  memory.update(old, { status: "done" });
  memory.save({ kind: "fact", text: "私人事实" });
  const done = memory.save({ kind: "goal", text: "已完成目标" });
  memory.update(done, { status: "done" });
  memory.save({ kind: "goal", text: "参加考试", due: at });
  at++;
  memory.save({ kind: "goal", text: "找实习" });
  at++;
  memory.save({ kind: "profile", text: "回答简短" });
  const raw = "今天安排什么？";
  await submitMessage(app.main, raw);
  await app.main.waitForIdle(context);
  const content = (await incoming(app)).at(-1)!;
  expect(content).toMatch(/^\[当前时间 [^\n]+\]\n\[记忆摘要\]/);
  expect(content).toMatch(/目标（已过期，待确认）.*参加考试/);
  expect(content.indexOf("回答简短")).toBeLessThan(content.indexOf("找实习"));
  expect(content).toContain("旧画像");
  expect(content).not.toMatch(/私人事实|已完成目标/);
  expect(content.endsWith("\n" + raw)).toBe(true);
  expect(await readTranscript(app.main)).toContainEqual({ kind: "user", text: raw, at: expect.any(Number) });
  at++;
  memory.save({ kind: "profile", text: "习".repeat(2000) });
  await submitMessage(app.main, raw);
  await app.main.waitForIdle(context);
  const capped = (await incoming(app)).at(-1)!.split("\n").slice(1, -1).join("\n");
  expect(capped).toHaveLength(1200);
});

it("lets a tainted main search memory but requires a separate user decision for each write", async () => {
  let id = "";
  const app = await open((text, last) => {
    if (last.role !== "user") return say("OK");
    if (text === "lease") return call("enable_tool", { capability: "remote", reason: "read" });
    if (text === "read") return call("remote_read", {});
    if (text === "search") return call("memory_search", { query: "考试" });
    if (text === "save") return call("memory_save", { kind: "goal", text: "考试" });
    if (text === "update") return call("memory_update", { id, text: "参加考试" });
    return call("memory_delete", { id });
  }, new MemoryStorage(), [externalPlugin().plugin], undefined, {}, false);
  await input(app, "lease");
  await input(app, "read");
  await input(app, "search");
  for (const action of ["save", "update", "delete"]) {
    await app.main.submit({ type: "input", content: action }, context);
    const request = await parked(app);
    expect(request).toMatchObject({ taskId: "main", audience: "user", tool: "memory_" + action,
      tainted: true, taint: { source: "remote_read" } });
    expect(app.memory.list().map(item => item.text)).toEqual(action === "save" ? [] : [action === "update" ? "考试" : "参加考试"]);
    await answerUserPermission(app.main, { requestId: request.id, decision: action === "delete" ? "deny" : "once" });
    await app.main.waitForIdle(context);
    id = app.memory.list()[0]!.id;
  }
  expect(app.memory.list()).toMatchObject([{ id, text: "参加考试" }]);
});

it("offers schedules without leases and parks tainted reminder creation and cancellation for the user", async () => {
  let id = "";
  const at = Date.parse("2026-11-22T03:00Z");
  const app = await open((text, last) => {
    if (last.role !== "user") return say("OK");
    if (text === "lease") return call("enable_tool", { capability: "remote", reason: "read" });
    if (text === "read") return call("remote_read", {});
    if (text === "list") return call("schedule_list", {});
    if (text === "create") return call("schedule_create", { text: "回电话", at: "2027-01-01T11:30", daily: "11:30" });
    return call("schedule_cancel", { id });
  }, new MemoryStorage(), [externalPlugin().plugin], undefined, { now: () => at }, false);
  await input(app, "lease");
  await input(app, "read");
  await input(app, "list");
  const reminders = async () => (await app.scheduler.list()).filter(item => item.kind === "reminder");
  for (const action of ["create", "cancel"]) {
    await app.main.submit({ type: "input", content: action }, context);
    const request = await parked(app);
    expect(request).toMatchObject({ audience: "user", taskId: "main", tool: "schedule_" + action, tainted: true });
    expect((await reminders()).map(item => item.status)).toEqual(action === "create" ? [] : ["scheduled"]);
    await answerUserPermission(app.main, { requestId: request.id, decision: "once" });
    await app.main.waitForIdle(context);
    id = (await reminders())[0]!.id;
  }
  expect(await reminders()).toMatchObject([{ id, text: "回电话", status: "cancelled" }]);
});

it("continues an ended conversation with its history and taint", async () => {
  let original = "";
  let sawHistory = false;
  let conflict = "";
  let historicalStatus = "";
  const { plugin } = externalPlugin();
  const app = await open((text, last, messages) => {
    if (text === "start") return dispatch("collect evidence");
    if (text === "collect evidence") return call("remote_read", {});
    if (last.role === "toolResult" && last.toolName === "remote_read") return finish("collected");
    if (text === "mix") return call("dispatch_task", { brief: "next", context: "fresh", continue_from: original });
    if (last.role === "toolResult" && last.toolName === "dispatch_task" && last.isError) conflict = text;
    if (text === "original status") return call("task_status", { taskId: original });
    if (last.role === "toolResult" && last.toolName === "task_status") historicalStatus = text;
    if (text === "resume") return call("dispatch_task", { brief: "use evidence", continue_from: original, thinking: "low" });
    if (text === "use evidence") {
      sawHistory = messages.some(m => m.role === "toolResult" && contentText(m.content) === "external text");
      return call("remote_send", {});
    }
    if (last.role === "toolResult" && last.toolName === "remote_send") return finish("used evidence");
    return say("ok");
  }, new MemoryStorage(), [plugin]);
  await input(app, "start");
  await expect.poll(async () => (await ledger(app)).length).toBe(1);
  original = (await ledger(app))[0]!.taskId;
  await input(app, "mix");
  expect(conflict).toContain("omit");
  await input(app, "resume");
  const req = await parked(app);
  expect(req).toMatchObject({ tool: "remote_send", tainted: true, taint: { source: "remote_read" } });
  expect(sawHistory).toBe(true);
  const tasks = (await app.harness.snapshot(Tasks, app.main.id, context))!.byId;
  expect(tasks[original]).toMatchObject({ status: "completed", thinking: "high" });
  expect(req.taskId).not.toBe(original);
  expect(tasks[req.taskId]).toMatchObject({ conversationId: tasks[original]!.conversationId, continuedFrom: original,
    permission: "restricted", thinking: "low" });
  const child = (await app.harness.conversation(tasks[original]!.conversationId, context))!;
  expect((await child.agent(context)).thinkingLevel).toBe("low");
  await input(app, "original status");
  expect(JSON.parse(historicalStatus)).toMatchObject({ taskId: original, status: "completed",
    latestTool: { name: "finish", arguments: JSON.stringify({ summary: "collected", refs: [] }) }, pending: [] });
  await answerUserPermission(app.main, { requestId: req.id, decision: "deny" });
  await expect.poll(async () => (await ledger(app)).map(e => e.summary)).toEqual(["collected", "used evidence"]);
});

it("summarizes a parked task, rejects live continuation, and delivers steering after approval across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-task-message-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const reopen = () => openNodeSqliteStorage(join(dir, "main.sqlite"));
  const results = new Map<string, string>();
  const long = "x".repeat(500);
  let id = "";
  const route: Route = (text, last, history) => {
    if (text === "start") return call("dispatch_task", { brief: "send", context: "fresh", permission: "auto", thinking: "medium" });
    if (text === "send") return say([{ type: "text", text: long }, fauxToolCall("outbox_send", { message: long })], { stopReason: "toolUse" });
    if (text === "list" || text === "detail") return call("task_status", text === "list" ? {} : { taskId: id });
    if (text === "continue") return call("dispatch_task", { continue_from: id, brief: "more" });
    if (text === "message") return call("task_message", { taskId: id, message: "revised brief" });
    if (text === "revised brief") return finish(history.some(m => m.role === "toolResult" && m.toolName === "outbox_send") ? "revised after approval" : "misordered");
    if (last.role === "toolResult") results.set(last.toolName, text);
    return say("ok");
  };
  const app = await open(route, await reopen());
  await input(app, "start");
  const req = await parked(app);
  id = req.taskId;
  await input(app, "list");
  expect(JSON.parse(results.get("task_status")!)).toEqual([{ taskId: id, brief: "send", status: "running", thinking: "medium" }]);
  await input(app, "detail");
  const detail = JSON.parse(results.get("task_status")!);
  expect(detail).toMatchObject({ status: "running", latestMessage: { source: id }, latestTool: { name: "outbox_send" }, pending: [{ id: req.id }] });
  expect(detail.latestMessage.text).toHaveLength(300);
  expect(detail.latestTool.arguments).toHaveLength(200);
  expect(detail.pending[0].arguments).toHaveLength(200);
  expect(results.get("task_status")).not.toContain(long);
  await input(app, "continue");
  expect(results.get("dispatch_task")).toContain("task_message");
  await input(app, "message");
  expect(results.get("task_message")).toBe("Message queued");
  expect((await app.harness.snapshot(Tasks, app.main.id, context))!.byId[id]!.messages).toEqual([{ at: expect.any(Number), text: "revised brief" }]);
  await app.close();
  const next = await open(route, await reopen());
  next.harness.resume();
  expect(await parked(next)).toMatchObject({ id: req.id });
  const record = (await next.harness.snapshot(Tasks, next.main.id, context))!.byId[id]!;
  expect((await (await next.harness.conversation(record.conversationId, context))!.agent(context)).thinkingLevel).toBe("medium");
  await answerUserPermission(next.main, { requestId: req.id, decision: "once" });
  await expect.poll(async () => (await ledger(next)).map(e => e.summary)).toEqual(["revised after approval"]);
  await input(next, "message");
  expect(results.get("task_message")).toContain("continue_from");
});

it("cancels a continued task during approval, removes the card, and stays cancelled after reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-task-cancel-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const reopen = () => openNodeSqliteStorage(join(dir, "main.sqlite"));
  let id = "";
  const route: Route = (text, last) => {
    if (text === "start") return dispatch("seed", "auto");
    if (text === "seed") return finish("seeded");
    if (text === "continue") return call("dispatch_task", { brief: "deliver", continue_from: id });
    if (text === "deliver") return call("outbox_send", { message: "never sent" });
    if (text === "message") return call("task_message", { taskId: id, message: "pending update" });
    if (text === "stop") return call("task_cancel", { taskId: id });
    if (last.role === "toolResult" && last.toolName === "outbox_send") return finish("sent");
    return say("ok");
  };
  const app = await open(route, await reopen());
  await input(app, "start");
  await expect.poll(async () => (await ledger(app)).length).toBe(1);
  id = (await ledger(app))[0]!.taskId;
  await input(app, "continue");
  const req = await parked(app);
  id = req.taskId;
  const surface = await observeSurface(app, () => {});
  expect(surface.snapshot().pending).toHaveLength(1);
  await input(app, "message");
  await input(app, "stop");
  expect(surface.snapshot().pending).toEqual([]);
  surface.detach();
  expect((await answerUserPermission(app.main, { requestId: req.id, decision: "once" })).isError).toBe(true);
  expect(app.demo.outbox).toEqual([]);
  await app.close();
  const next = await open(route, await reopen());
  next.harness.resume();
  await input(next, "stop");
  const task = (await next.harness.snapshot(Tasks, next.main.id, context))!.byId[id]!;
  expect(task.status).toBe("cancelled");
  expect((await next.harness.snapshot(LiveDoc, task.conversationId, context))?.run).toBeUndefined();
  expect((await ledger(next)).map(e => e.summary)).toEqual(["seeded", "cancelled"]);
  expect((await next.harness.snapshot(Requests, next.main.id, context))!.pending).toEqual({});
  expect(next.demo.outbox).toEqual([]);
});

it("interrupts an outstanding model request before acknowledging task_cancel", async () => {
  let id = "";
  let waiting = false;
  let aborted = false;
  let receipt = "";
  const app = await open((text, last, _history, _tools, signal) => {
    if (text === "start") return dispatch("wait");
    if (text === "wait") {
      waiting = true;
      return new Promise(resolve => signal!.addEventListener("abort", () => {
        aborted = true;
        resolve(finish("too late"));
      }, { once: true }));
    }
    if (text === "stop") return call("task_cancel", { taskId: id });
    if (last.role === "toolResult" && last.toolName === "task_cancel") receipt = text;
    return say("ok");
  });
  await input(app, "start");
  await expect.poll(() => waiting).toBe(true);
  id = Object.keys((await app.harness.snapshot(Tasks, app.main.id, context))!.byId)[0]!;
  await input(app, "stop");
  expect(aborted).toBe(true);
  expect(receipt).toContain("cancelled");
  expect((await ledger(app)).map(e => e.summary)).toEqual(["cancelled"]);
});

it.each(["finish", "answer"])("handles steering while the model is about to %s", async boundary => {
  let id = "";
  let release: (() => void) | undefined;
  const app = await open(async text => {
    if (text === "start") return dispatch("initial brief");
    if (text === "initial brief") {
      await new Promise<void>(resolve => { release = resolve; });
      return boundary === "finish" ? finish("obsolete") : say("initial answer");
    }
    if (text === "update") return call("task_message", { taskId: id, message: "updated brief" });
    if (text === "updated brief") return finish("updated result");
    return say("ok");
  });
  await input(app, "start");
  await expect.poll(() => !!release).toBe(true);
  id = Object.keys((await app.harness.snapshot(Tasks, app.main.id, context))!.byId)[0]!;
  try { await input(app, "update"); } finally { release!(); }
  await expect.poll(async () => (await ledger(app)).map(e => e.summary)).toEqual(["updated result"]);
});
