import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as say, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it } from "vitest";
import { answerUserPermission, approvalStats, Audit, isApprovalDecision, submitMessage, stats, judge, readUsage, observeSurface, openAlter, type ApprovalDecision } from "../src/index.ts";
import { context, defineTool, MemoryStorage, openNodeSqliteStorage, reply, type Storage } from "../src/runtime.ts";
import { obj } from "@earendil-works/pi-schema";

import { recentUserText } from "../src/timeline.ts";
import { ScopeDoc, Tasks } from "../src/state.ts";
import { Reviews } from "../src/broker.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const call = (tool: string, args: Parameters<typeof fauxToolCall>[1]) => say(fauxToolCall(tool, args), { stopReason: "toolUse" });
const first = { tool: "outbox_send", target: "team", purpose: "status" };
const brief = { tool: "", target: "任务 brief", purpose: "work" };
const original = { tool: "", target: "", purpose: "start" };
const send = (message = "team") => call("outbox_send", { message });
const finish = call("finish", { summary: "done", refs: [] });
const ref = { provider: "worker", modelId: "faux-1" };
const positive = () => say('```json\n{"inScope":true,"reason":"符合说明"}\n```');

async function setup(steps: FauxResponseStep[], verdict: FauxResponseStep = positive, disk = false) {
  const clock = { now: Date.now() };
  const main = fauxProvider({ tokensPerSecond: Infinity });
  const worker = fauxProvider({ provider: "worker", tokensPerSecond: Infinity, models: [{ id: ref.modelId, reasoning: true }] });
  const judged: { statement: typeof first[]; call: { tool: string; arguments: unknown } }[] = [];
  let deletes = 0;
  main.setResponses([call("dispatch_task", { brief: "work", context: "fresh", permission: "restricted" }), say("working"), say("done")]);
  const models = createModels();
  models.setProvider(main.provider);
  models.setProvider(worker.provider);
  worker.setResponses(Array.from({ length: 60 }, () => (ctx, options, state, model) => {
    const review = options?.metadata?.alterConversation === "judge";
    if (review) judged.push(JSON.parse(contentText(ctx.messages.at(-1)!.content)));
    const next = review ? verdict : steps.shift();
    if (!next) throw new Error("Unexpected worker call");
    return typeof next === "function" ? next(ctx, options, state, model) : next;
  }));
  const dir = disk ? await mkdtemp(join(tmpdir(), "alter-approval-")) : undefined;
  if (dir) cleanup.push(() => rm(dir, { recursive: true, force: true }));
  async function open(storage: Storage) {
    const app = await openAlter(storage, models, { provider: "faux", modelId: "faux-1" }, ref, {}, {
      now: () => clock.now, approvalDefaultMs: 60_000, plugins: [{
        capability: { id: "fixture", mainLeasable: false, actions: [{ name: "delete", effect: "irreversible" }, { name: "erase", effect: "irreversible" }] },
        tools: ["delete", "erase"].map(action => defineTool({ name: "fixture_" + action, description: action, parameters: obj({}),
          execute: async () => { deletes++; return reply("deleted"); } })),
      }],
    });
    const surface = await observeSurface(app, () => {});
    const close = async () => { surface.detach(); await app.close(); };
    cleanup.push(close);
    return { app, surface, close, async park(tool = "outbox_send", message?: string) {
      const get = () => surface.snapshot().pending.find(r => r.tool === tool && (!message || JSON.stringify(r.arguments).includes(message)));
      await expect.poll(get, { timeout: 4000 }).toBeDefined();
      return get()!;
    }, async decide(requestId: string, decision: ApprovalDecision) {
      const answer = await answerUserPermission(app.main, { requestId, decision });
      expect(answer.output[0]?.text).toBe("delivered");
    } };
  }
  const reopen = async () => open(dir ? await openNodeSqliteStorage(join(dir, "main.sqlite")) : new MemoryStorage());
  const f = await reopen();
  return { ...f, mainModel: main, dir, clock, judged, deletes: () => deletes, reopen,
    start: (text = "start") => submitMessage(f.app.main, text) };
}

it("judges with only the statement and call, low reasoning and no tools, and fails closed", async () => {
  const models = createModels();
  const mock = fauxProvider({ provider: ref.provider });
  models.setProvider(mock.provider);
  let payload: unknown, reasoning: unknown, tools: unknown;
  mock.setResponses([(ctx, options) => {
    payload = ctx.messages.filter(m => m.role !== "system").map(m => JSON.parse(contentText(m.content)));
    reasoning = options?.reasoning;
    tools = ctx.messages.flatMap(m => m.role === "system" ? m.toolsAdded ?? [] : []);
    return positive();
  }, say("invalid"), say(JSON.stringify({ inScope: true, reason: "x".repeat(81) })), say('{"inScope":"true","reason":"ok"}')]);
  const invocation = { tool: first.tool, arguments: { message: "team" } };
  expect(await judge(models, ref, [first], invocation)).toEqual({ inScope: true, reason: "符合说明" });
  expect({ payload, reasoning, tools }).toEqual({ payload: [{ statement: [first], call: invocation }], reasoning: "low", tools: [] });
  for (let i = 0; i < 3; i++) expect((await judge(models, ref, [first], invocation)).inScope).toBe(false);
  expect((await judge(models, ref, [first], { ...invocation, arguments: { message: "x".repeat(20_000) } })).inScope).toBe(false);
  expect(mock.state.callCount).toBe(4);
});

it("checks writes against the dispatch snapshot and brief, then asks for out-of-scope and irreversible calls", async () => {
  const f = await setup([send(), send(), send("other"), call("fixture_delete", {}), finish],
    ctx => JSON.parse(contentText(ctx.messages.at(-1)!.content)).call.arguments.message === "team"
      ? positive() : say('{"inScope":false,"reason":"对象不同"}'), true);
  f.app.settings.set("on");
  await f.start();
  const outside = await f.park("outbox_send", "other");
  expect(outside.statement).toEqual([{ ...original, isNew: false }, { ...brief, isNew: false }]);
  expect(f.judged.map(j => j.statement)).toEqual(Array(3).fill([original, brief]));
  expect(f.app.demo.outbox).toEqual(["team", "team"]);
  expect(f.surface.snapshot().ledger.find(row => row.taskId !== "main")?.summary).toContain("审批模型放行");
  await f.decide(outside.id, "once");
  const irreversible = await f.park("fixture_delete");
  expect(f.deletes()).toBe(0);
  expect(f.judged).toHaveLength(3);
  await f.decide(irreversible.id, "deny");
  await expect.poll(() => f.surface.snapshot().tasks[0]?.status).toBe("completed");
  expect(f.deletes()).toBe(0);
  const { approvals } = await stats("day", f.app.timeZone, { app: f.app, dir: f.dir! });
  expect(approvals).toMatchObject({ userDecisions: { once: 1, deny: 1, capability: 0, always: 0 },
    byApprover: [{ approver: "user", count: 2 }, { approver: "judge", count: 2 }, { approver: "timeout", count: 0 }] });
});

it("scopes a capability grant to the selected capability", async () => {
  const f = await setup([call("fixture_delete", {}), call("fixture_erase", {}), send(), finish]);
  f.app.settings.set("off");
  await f.start();
  await f.decide((await f.park("fixture_delete")).id, "capability");
  await f.decide((await f.park()).id, "deny");
  expect(f.deletes()).toBe(2);
  expect(f.judged).toEqual([]);
});

it("keeps a deferred approval across restart and allows rewritten arguments for ten minutes", async () => {
  const results: string[] = [];
  const f = await setup([send(), ctx => {
    results.push(contentText(ctx.messages.at(-1)!.content));
    return call("fixture_delete", {});
  }, send("other"), () => { f.clock.now += 599_999; return send(); }, () => { f.clock.now++; return send(); }, finish], say('{"inScope":false,"reason":"待确认"}'), true);
  f.app.settings.set("on");
  await f.start();
  const req = await f.park();
  f.clock.now = req.defaultAt!;
  f.app.harness.resume();
  await f.park("fixture_delete");
  expect(results[0]).toContain("暂未获批");
  expect((await readUsage(f.dir!)).filter(line => line.role === "judge")).toMatchObject([
    { conversation: "judge", model: ref.modelId, taskId: req.taskId, thinking: "low", outcome: "ok" },
  ]);
  expect(f.surface.snapshot().pending.find(p => p.id === req.id)?.deferred).toBe(true);
  await f.close();
  const g = await f.reopen();
  g.app.harness.resume();
  expect(g.app.settings.approvalModel).toBe("on");
  await g.decide(req.id, "once");
  await g.decide((await g.park("fixture_delete")).id, "once");
  const repeat = await g.park("outbox_send", "team");
  expect(g.app.demo.outbox).toEqual(["other", "team"]);
  await g.decide(repeat.id, "deny");
  await expect.poll(() => g.surface.snapshot().tasks[0]?.status).toBe("completed");
});

it("defers an irreversible call without a judge and expires its detached card once at the final deadline", async () => {
  let message = "";
  const f = await setup([call("fixture_delete", {}), ctx => {
    message = contentText(ctx.messages.at(-1)!.content);
    return finish;
  }], positive, true);
  f.app.settings.set("on");
  await f.start();
  const req = await f.park("fixture_delete");
  f.clock.now = req.defaultAt!;
  f.app.harness.resume();
  await expect.poll(() => f.surface.snapshot().tasks[0]?.status).toBe("completed");
  expect(message).toContain("暂未获批");
  expect(f.surface.snapshot().pending[0]?.deferred).toBe(true);
  await f.close();
  const g = await f.reopen();
  f.clock.now = req.expiresAt;
  expect((await answerUserPermission(g.app.main, { requestId: req.id, decision: "once" })).isError).toBe(true);
  g.app.harness.resume();
  await expect.poll(() => g.surface.snapshot().pending.length).toBe(0);
  expect(f.judged).toHaveLength(0);
  expect(f.deletes()).toBe(0);
});

it("asks directly when a user instruction is too long to snapshot", async () => {
  let result = "";
  const f = await setup([send(), ctx => { result = contentText(ctx.messages.at(-1)!.content); return finish; }]);
  f.app.settings.set("on");
  await f.start("x".repeat(1001));
  const req = await f.park();
  f.clock.now = req.defaultAt!;
  f.app.harness.resume();
  await expect.poll(() => result).toContain("暂未获批");
  expect(f.app.demo.outbox).toEqual([]);
  await f.decide(req.id, "deny");
  expect(f.judged).toHaveLength(0);
  expect((await approvalStats(f.app.main)).userDenied).toBe(1);
});

it("resumes statement authorizations from SQLite without asking again for an in-scope call", async () => {
  const f = await setup([send(), call("fixture_delete", {}), send(), finish], positive, true);
  f.app.settings.set("on");
  await f.start();
  const held = await f.park("fixture_delete");
  await f.close();
  const g = await f.reopen();
  g.app.harness.resume();
  await g.decide(held.id, "once");
  await expect.poll(() => g.surface.snapshot().tasks[0]?.status).toBe("completed");
  expect(g.app.demo.outbox).toEqual(["team"]);
  expect(f.judged.map(j => j.statement)).toEqual(Array(2).fill([original, brief]));
  expect(g.surface.snapshot().ledger.filter(row => row.taskId !== "main").map(row => row.summary)).toEqual([expect.stringContaining("审批模型放行"), expect.stringContaining("审批模型放行"), "done"]);
});

it("leases without review and judges the write against ten recent original user inputs", async () => {
  const f = await setup([]);
  const texts = Array.from({ length: 12 }, (_, i) => "用户原话 " + i);
  f.mainModel.setResponses([...texts.slice(0, -1).map(() => say("模型回复")), say("系统唤醒"),
    call("enable_tool", { capability: "outbox" }), send(), say("完成")]);
  for (const text of texts.slice(0, -1)) {
    await submitMessage(f.app.main, text);
    await f.app.main.waitForIdle(context);
  }
  await submitMessage(f.app.main, "内部调度内容", "schedule");
  await f.app.main.waitForIdle(context);
  await f.app.main.commit(tx => tx.appendEntry(f.app.main.id, {
    kind: "alter.task-report", data: { source: "web", text: "工具执行结果和任务报告" },
  }), context);
  await submitMessage(f.app.main, texts.at(-1)!);
  await f.app.main.waitForIdle(context);
  expect(f.app.demo.outbox).toEqual(["team"]);
  expect(f.judged.map(j => j.call.tool)).toEqual(["outbox_send"]);
  for (const { statement } of f.judged) {
    expect(statement).toEqual(texts.slice(-10).map(purpose => ({ tool: "", target: "", purpose })));
  }
  expect(await approvalStats(f.app.main)).toEqual({ modelAllowed: 1, askedUser: 0, userApproved: 0, userDenied: 0 });
});

it("migrates stored approval modes, audit effects and statement decisions on reopen", async () => {
  const f = await setup([], positive, true);
  const effects = ["write-local", "external-send", "unknown"];
  await f.app.main.commit(async tx => {
    const audit = await tx.doc(Audit, f.app.main.id);
    for (const effect of effects) {
      audit.entries.push(JSON.parse(JSON.stringify({ taskId: "legacy", tool: "legacy_tool", capability: "legacy", action: "tool",
        effect, decision: "allow", at: 1, tainted: true })));
    }
    (await tx.doc(Reviews, f.app.main.id)).byId.legacy = JSON.parse('{"user":"statement"}');
  }, context);
  await f.close();
  const path = join(f.dir!, "settings.json");
  await writeFile(path, JSON.stringify({ approvalModel: "shadow" }));
  const g = await f.reopen();
  expect(g.app.settings.approvalModel).toBe("on");
  expect(JSON.parse(await readFile(path, "utf8")).approvalModel).toBe("on");
  const audit = await g.app.harness.snapshot(Audit, g.app.main.id, context);
  expect(audit?.entries.map(e => e.effect)).toEqual(["write", "write", "irreversible"]);
  for (const entry of audit!.entries) expect(entry).not.toHaveProperty("tainted");
  expect((await approvalStats(g.app.main)).userApproved).toBe(1);
  expect(isApprovalDecision("statement")).toBe(false);
});

it("requires a user decision for an unrecognized runtime effect even with an in-scope statement", async () => {
  const tool = "fixture_delete";
  const f = await setup([call(tool, {}), finish]);
  // Simulate a stale runtime descriptor after registration of a valid manifest.
  Object.assign(f.app.capabilities.toolActions.get(tool)!, { effect: "future-effect" });
  await f.start();
  const request = await f.park(tool);
  expect(f.judged).toEqual([]);
  expect(f.deletes()).toBe(0);
  await f.decide(request.id, "deny");
  await expect.poll(() => f.surface.snapshot().tasks[0]?.status).toBe("completed");
  const audit = await f.app.harness.snapshot(Audit, f.app.main.id, context);
  expect(audit?.entries.filter(row => row.tool === tool).map(row => row.effect)).toEqual(["irreversible", "irreversible"]);
});

it("lets the main session write memories without asking", async () => {
  const f = await setup([]);
  f.mainModel.setResponses([call("memory_write", { op: "add", type: "preference", title: "咖啡", body: "只喝美式不加糖。" }), say("记下了")]);
  await submitMessage(f.app.main, "随口一提：我喝美式");
  await f.app.main.waitForIdle(context);
  expect(f.surface.snapshot().pending).toEqual([]);
  expect(f.judged).toEqual([]);
});

it("ends a main capability grant with the lease that prompted it", async () => {
  const f = await setup([]);
  f.app.settings.set("off");
  const rent = call("enable_tool", { capability: "fixture" });
  f.mainModel.setResponses([rent, call("fixture_delete", {}), call("fixture_erase", {}), say("完成"),
    ...Array(30).fill(say("空闲")), rent, call("fixture_erase", {}), say("完成")]);
  await f.start();
  await f.decide((await f.park("fixture_delete")).id, "capability");
  await f.app.main.waitForIdle(context);
  expect(f.deletes()).toBe(2);
  for (let i = 0; i < 30; i++) {
    await submitMessage(f.app.main, "空闲");
    await f.app.main.waitForIdle(context);
  }
  await f.start();
  await f.decide((await f.park("fixture_erase")).id, "deny");
  expect(f.deletes()).toBe(2);
});

it("uses the inclusive two-hour boundary and keeps up to 4000 characters of complete messages", async () => {
  const f = await setup([]);
  const at = f.clock.now;
  const add = (text: string, time: number) => f.app.main.commit(tx => tx.appendEntry(f.app.main.id, {
    kind: "alter.user-input", data: { source: "cli", text, at: time },
  }), context);
  const window = () => f.app.main.commit(tx => recentUserText(tx, f.app.main.id, at), context);
  await add("旧".repeat(1001), at - 7200001);
  await add("边界", at - 7200000);
  expect(await window()).toEqual(["边界"]);
  const latest = ["甲", "乙", "丙", "丁"].map(c => c.repeat(1000));
  for (const text of latest) await add(text, at);
  expect(await window()).toEqual(latest);
  await add("新", at);
  expect(await window()).toEqual([...latest.slice(1), "新"]);
  await add("超".repeat(1001), at);
  expect(await window()).toBeUndefined();
});

it("migrates a legacy task-wide decision to its capability and keeps existing statement items", async () => {
  const f = await setup([send(), call("fixture_delete", {}), send("again"), call("fixture_erase", {}), finish], positive, true);
  f.app.settings.set("off");
  await f.start();
  const firstRequest = await f.park();
  await f.decide(firstRequest.id, "capability");
  const held = await f.park("fixture_delete");
  await f.app.main.commit(async tx => {
    const task = (await tx.doc(Tasks, f.app.main.id)).byId[held.taskId]!;
    const scope = await tx.doc(ScopeDoc, task.conversationId);
    delete scope.capabilities;
    Object.assign(scope, { full: true, items: [first], declarations: ["legacy"] });
    Object.assign((await tx.doc(Reviews, f.app.main.id)).byId[firstRequest.id]!, { user: "task-full" });
  }, context);
  await f.close();
  const g = await f.reopen();
  g.app.harness.resume();
  await g.decide(held.id, "once");
  const other = await g.park("fixture_erase");
  expect(other.statement).toEqual([{ ...first, isNew: false }]);
  expect(g.app.demo.outbox).toEqual(["again"]);
  expect((await g.app.harness.snapshot(Reviews, g.app.main.id, context))?.byId[firstRequest.id]?.user).toBe("capability");
  await g.decide(other.id, "deny");
});

it.each(["once", "capability"] as const)("does not carry %s into a task continuing the same conversation", async decision => {
  const f = await setup([send(), finish, send("new"), finish]);
  f.app.settings.set("off");
  await f.start();
  const held = await f.park();
  await f.decide(held.id, decision);
  await expect.poll(() => f.surface.snapshot().tasks[0]?.status).toBe("completed");
  await f.app.main.waitForIdle(context);
  f.mainModel.setResponses([call("dispatch_task", { brief: "new brief", continue_from: held.taskId }), say("working"), say("done")]);
  await f.start("new instructions");
  const next = await f.park("outbox_send", "new");
  expect(next.taskId).not.toBe(held.taskId);
  expect(next.statement?.map(item => item.purpose)).toEqual(["start", "new instructions", "new brief"]);
  await f.decide(next.id, "deny");
  expect(f.app.demo.outbox).toEqual(["team"]);
});

it("recovers a recent pre-upgrade once decision from its click time", async () => {
  const f = await setup([send(), call("fixture_delete", {}), send("rewritten"), finish], positive, true);
  f.app.settings.set("off");
  await f.start();
  const req = await f.park();
  await f.decide(req.id, "once");
  const held = await f.park("fixture_delete");
  await f.app.main.commit(async tx => {
    const task = (await tx.doc(Tasks, f.app.main.id)).byId[req.taskId]!;
    Object.assign(await tx.doc(ScopeDoc, task.conversationId), { late: [{ tool: req.tool, argumentsJson: '{"message":"team"}' }] });
  }, context);
  await f.close();
  f.clock.now += 599_999;
  const g = await f.reopen();
  g.app.harness.resume();
  // The unrelated irreversible request has reached its soft deadline during downtime.
  await g.decide(held.id, "once");
  await expect.poll(() => g.app.demo.outbox).toEqual(["rewritten"]);
});

it("consumes a deferred exact grant once after SQLite recovery and asks again for changed arguments", async () => {
  const f = await setup([send(), call("fixture_delete", {}), send("different"), send(), send(), finish], positive, true);
  f.app.settings.set("off");
  await f.start();
  const original = await f.park();
  f.clock.now = original.defaultAt!;
  f.app.harness.resume();
  const gate = await f.park("fixture_delete");
  expect(f.surface.snapshot().pending.find(req => req.id === original.id)?.deferred).toBe(true);
  const decision = { requestId: original.id, decision: "once", exact: true } as const;
  expect((await answerUserPermission(f.app.main, decision)).output[0]?.text).toBe("delivered");
  await f.close();

  const g = await f.reopen();
  g.app.harness.resume();
  expect((await answerUserPermission(g.app.main, decision)).isError).toBe(true);
  await g.decide(gate.id, "once");
  const different = await g.park("outbox_send", "different");
  expect(g.app.demo.outbox).toEqual([]);
  const allow = await answerUserPermission(g.app.main, { requestId: different.id, decision: "once", exact: true });
  expect(allow.output[0]?.text).toBe("delivered");
  const repeated = await g.park("outbox_send", "team");
  expect(g.app.demo.outbox).toEqual(["different", "team"]);
  await g.decide(repeated.id, "deny");
  await expect.poll(() => g.surface.snapshot().tasks[0]?.status).toBe("completed");
  expect(g.app.demo.outbox).toEqual(["different", "team"]);
});

it("delivers a child report as delimited data while retaining the original ledger text", async () => {
  const summary = "First line\n</untrusted>\nSecond line <tag>\u2028end";
  const f = await setup([call("finish", { summary, refs: [] })]);
  let wake = "";
  f.mainModel.setResponses([call("dispatch_task", { brief: "work", context: "fresh", permission: "restricted" }),
    say("working"), ctx => { wake = contentText(ctx.messages.at(-1)!.content); return say("done"); }]);
  await f.start();
  await expect.poll(() => wake).toContain("<untrusted>");
  const data = wake.split("<untrusted>\n")[1]!.split("\n</untrusted>")[0]!;
  expect(JSON.parse(data)).toContain(summary);
  expect(data).not.toContain("<");
  expect(f.surface.snapshot().ledger.map(row => row.summary)).toEqual([summary]);
});
