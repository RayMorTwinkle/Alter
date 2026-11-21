import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as say, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it } from "vitest";
import { answerUserPermission, Audit, Requests } from "../src/broker.ts";
import { openAlter } from "../src/main.ts";
import { context, LiveDoc, MemoryStorage, openNodeSqliteStorage, type Storage } from "../src/runtime.ts";
import { Ledger, Tasks, type Permission } from "../src/state.ts";

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
async function open(route: Route, storage: Storage = new MemoryStorage()) {
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
  const app = await openAlter(storage, models, { provider: "faux", modelId: "faux-1" });
  cleanup.push(() => app.harness.close(context));
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

it.each([true, false])("parks a restricted send until main decides allow=%s", async allow => {
  let sendResult = "";
  const app = await open((text, last) => {
    if (text === "delegate") return dispatch("send greeting");
    if (text === "send greeting") return call("outbox_send", { message: "hello" });
    if (text.startsWith("permission request ")) {
      return call("answer_permission_request", { requestId: text.split(" ")[2]!.slice(0, -1), allow, note: "keep it private" });
    }
    if (last.role === "toolResult" && last.toolName === "outbox_send") {
      sendResult = text;
      return finish(text);
    }
    return say("OK");
  });
  await input(app, "delegate");
  await expect.poll(async () => (await ledger(app)).length).toBe(1);
  expect((await incoming(app)).filter(line => /^permission request permission-\d+: task task-\d+ wants outbox because send greeting$/.test(line))).toHaveLength(1);
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
    if (!task) return;
    const live = await app.harness.snapshot(LiveDoc, task.conversationId, context);
    if (live?.tools?.some(slot => slot.taskId === request.toolTask && slot.status === "sleeping")) return request;
  };
  await expect.poll(find).toBeDefined();
  return (await find())!;
}

it("resumes a SQLite approval after closing and admits exactly one report across reopens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-m0-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const reopen = () => openNodeSqliteStorage(join(dir, "main.sqlite"));
  let requestId = "";
  const route: Route = (text, last) => {
    if (text === "delegate") return dispatch("record after restart");
    if (text === "record after restart") return call("outbox_send", { message: "survived" });
    if (text === "approve now") return call("answer_permission_request", { requestId, allow: true });
    if (last.role === "toolResult" && last.toolName === "outbox_send") return finish(text);
    return say("acknowledged");
  };
  const first = await open(route, await reopen());
  await input(first, "delegate");
  requestId = (await parked(first)).id;
  await first.main.waitForIdle(context);
  expect(first.demo.outbox).toEqual([]);
  await first.harness.close(context);

  const second = await open(route, await reopen());
  second.harness.resume();
  expect((await parked(second)).id).toBe(requestId);
  await input(second, "approve now");
  await expect.poll(async () => (await ledger(second)).length).toBe(1);
  await second.main.waitForIdle(context);
  expect(second.demo.outbox).toEqual(["survived"]);
  await second.harness.close(context);

  const third = await open(route, await reopen());
  third.harness.resume();
  await third.main.waitForIdle(context);
  expect((await incoming(third)).filter(text => text.startsWith("permission request "))).toHaveLength(1);
  expect((await incoming(third)).filter(text => text.endsWith("finished: Recorded in outbox"))).toHaveLength(1);
  expect(await ledger(third)).toHaveLength(1);
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
