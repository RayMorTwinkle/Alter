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
type Route = (text: string, last: Message, history: Message[], offered: string[]) => AssistantMessage;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

function call(name: string, args: Parameters<typeof fauxToolCall>[1]) {
  return say(fauxToolCall(name, args), { stopReason: "toolUse" });
}
function dispatch(brief: string, permission: Permission = "restricted", allow: string[] = [], mode = "fresh") {
  return call("dispatch_task", { brief, permission, allow, context: mode });
}
function finish(summary: string) {
  return call("finish", { summary, refs: [] });
}
async function open(route: Route, storage: Storage = new MemoryStorage(), plugins: AlterPlugin[] = [], approvalTimeoutMs?: number) {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 160 }, () => ({ messages }) => {
    const tools = new Set<string>();
    for (const msg of messages) {
      if (msg.role !== "system") continue;
      for (const tool of msg.toolsRemoved ?? []) tools.delete(tool.name);
      for (const tool of msg.toolsAdded ?? []) tools.add(tool.name);
    }
    const last = messages.findLast(msg => msg.role !== "system")!;
    return route(contentText(last.content), last, messages, [...tools].sort());
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await openAlter(storage, models, { provider: "faux", modelId: "faux-1" }, undefined, {}, { plugins, approvalTimeoutMs });
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

const controls = ["answer_permission_request", "dispatch_task", "enable_tool", "task_status"];
const taskTools = ["calendar_create", "calendar_list", "calendar_update", "finish", "notes_read", "outbox_send", "request_capability"];

it("dispatches a fresh notes task and delivers its ledger summary to the main model", async () => {
  const seen: string[] = [];
  const app = await open((text, last, _, offered) => {
    if (text === "delegate") {
      seen.push(offered.join(","));
      return dispatch("read welcome", "restricted", ["notes"]);
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

it.each([true, false])("routes a restricted send to the user even when main allowed outbox, allow=%s", async allow => {
  let sendResult = "";
  const app = await open((text, last) => {
    if (text === "delegate") return dispatch("send greeting", "restricted", ["outbox"]);
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
  await answerUserPermission(app.main, { requestId: request.id, allow, note: "keep it private" });
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
  await answerUserPermission(second.main, { requestId, allow: true });
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

it.each(["user", "main"])("expires an unanswered %s approval and notifies main once", async audience => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const tool = audience === "user" ? "outbox_send" : "request_capability";
    const notifications: string[] = [];
    const app = await open((text, last) => {
      if (text === "delegate") return dispatch("work");
      if (text === "work") return call(tool, audience === "user" ? { message: "hello" } : { capability: "notes", reason: "read" });
      if (last.role === "toolResult" && last.toolName === tool) return finish(text);
      if (text.startsWith("Notify the user:")) notifications.push(text);
      return say("OK");
    });
    await input(app, "delegate");
    const request = await parked(app);
    expect(request).toMatchObject({ audience, expiresAt: now + 86_400_000 });
    clock.mockReturnValue(request.expiresAt);
    if (audience === "user") expect((await answerUserPermission(app.main, { requestId: request.id, allow: true })).isError).toBe(true);
    app.harness.resume();
    await expect.poll(async () => (await ledger(app)).map(e => e.summary)).toEqual([expect.stringContaining("Approval expired without a decision")]);
    await app.main.waitForIdle(context);
    expect(notifications).toEqual([`Notify the user: task ${request.taskId}, request ${request.id} (${tool}): Approval expired without a decision`]);
    expect(app.demo.outbox).toEqual([]);
    expect((await app.harness.snapshot(Tasks, app.main.id, context))?.byId[request.taskId]?.allow).toEqual([]);
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
  await answerUserPermission(app.main, { requestId, allow: true });
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
    if (text === "delegate") return dispatch("schedule and notify", "auto", ["outbox"]);
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
  expect(JSON.parse(status)).toMatchObject([{ taskId: request.taskId, status: "running", pending: [{ id: request.id, audience: "user" }] }]);
  expect(JSON.parse(status)[0].pending[0].remainingMs).toBeGreaterThan(0);
  expect(JSON.parse(status)[0].pending[0].remainingMs).toBeLessThanOrEqual(86_400_000);
  await input(app, "approve as main");
  expect(mainResult).toContain("No pending request for this approver");
  expect(app.demo.outbox).toEqual([]);
  expect((await answerUserPermission(app.main, { requestId, allow: true })).isError).toBe(false);
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
    if (text === "delegate") return dispatch("recall the codename", "restricted", [], mode);
    if (text === "recall the codename") {
      return finish(messages.some(msg => msg.role === "user" && contentText(msg.content) === fact) ? "Juniper" : "unknown");
    }
    return say("OK");
  });
  await input(app, fact);
  await input(app, "delegate");
  await expect.poll(async () => (await ledger(app)).map(e => e.summary)).toEqual([mode === "fork" ? "Juniper" : "unknown"]);
});

it.each(["restricted", "full"] as const)("audits explicit capability requests and subsequent calls in %s mode", async permission => {
  const app = await open((text, last) => {
    if (text === "delegate") return dispatch("send with permission", permission);
    if (text === "send with permission") return call("request_capability", { capability: "outbox", reason: "deliver the greeting" });
    if (text.startsWith("permission request ")) return call("answer_permission_request", { requestId: text.split(" ")[2]!.slice(0, -1), allow: true });
    if (last.role === "toolResult" && last.toolName === "request_capability") return call("outbox_send", { message: "hello" });
    if (last.role === "toolResult" && last.toolName === "outbox_send") return finish(text);
    return say("OK");
  });
  await input(app, "delegate");
  if (permission === "restricted") {
    // Main grants the capability; the send itself still waits for the user.
    const send = await parked(app);
    expect([send.tool, send.audience]).toEqual(["outbox_send", "user"]);
    await answerUserPermission(app.main, { requestId: send.id, allow: true });
  }
  await expect.poll(async () => (await ledger(app)).length).toBe(1);
  expect(app.demo.outbox).toEqual(["hello"]);
  const requests = (await incoming(app)).filter(text => text.startsWith("permission request "));
  expect(requests).toHaveLength(permission === "restricted" ? 1 : 0);
  if (permission === "restricted") expect(requests[0]).toMatch(/wants outbox because deliver the greeting$/);
  expect((await app.harness.snapshot(Audit, app.main.id, context))?.entries.filter(e => e.decision === "allow").map(e => e.tool))
    .toEqual(["request_capability", "outbox_send", "finish"]);
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
      return dispatch("send mail", "auto", ["mail"]);
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
  await answerUserPermission(app.main, { requestId: request.id, allow: true });
  await expect.poll(async () => (await ledger(app)).length).toBe(1);
  expect([...mail.sent.keys()]).toEqual([(await ledger(app))[0]!.summary]);
  expect(mail.clients.smtp).toHaveBeenCalledTimes(1);
  expect((await app.harness.snapshot(Audit, app.main.id, context))?.entries.filter(e => e.tool === "mail_send")
    .map(e => [e.effect, e.decision])).toEqual([["external-send", "park"], ["external-send", "allow"]]);
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
    if (text === "delegate") return dispatch("read clock", "restricted", ["clock"]);
    if (last.role === "toolResult") results.push(text);
    return say("OK");
  };
  const installed = await open(route, new MemoryStorage(), [plugin]);
  const plain = await open(route);
  await input(installed, "clock please");
  await input(installed, "time");
  await input(plain, "clock please");
  await input(plain, "delegate");
  expect(results).toEqual(["Enabled clock", "noon", "Capability is not leasable", "Unknown capability in allow"]);
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
      if (last.toolName === "remote_read") return call("request_capability", { capability: "remote", reason: "use remote" });
      if (last.toolName === "request_capability") return call(tool, {});
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
  await answerUserPermission(app.main, { requestId: request.id, allow: true });
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
    if (text === "fork" || text === "fresh") return dispatch("send report", "full", [], text);
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
  await answerUserPermission(app.main, { requestId: forked.id, allow: false });
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
  await answerUserPermission(app.main, { requestId: req.id, allow: true });
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
