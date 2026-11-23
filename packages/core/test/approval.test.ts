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

import { Reviews } from "../src/broker.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const call = (tool: string, args: Parameters<typeof fauxToolCall>[1]) => say(fauxToolCall(tool, args), { stopReason: "toolUse" });
const first = { tool: "outbox_send", target: "team", purpose: "status" };
const extra = { tool: "outbox_send", target: "other", purpose: "follow up" };
const declare = (item = first) => call("declare_permissions", { items: [item] });
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
        capability: { id: "fixture", mainLeasable: false, actions: [{ name: "delete", effect: "irreversible" }] },
        tools: [defineTool({ name: "fixture_delete", description: "delete", parameters: obj({}),
          execute: async () => { deletes++; return reply("deleted"); } })],
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
    start: () => f.app.main.submit({ type: "input", content: "start" }, context) };
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

it("checks writes against the latest declaration, then asks for out-of-scope and irreversible calls", async () => {
  const f = await setup([declare(), send(), declare(extra), send(), send("other"), call("fixture_delete", {}), finish],
    ctx => JSON.parse(contentText(ctx.messages.at(-1)!.content)).call.arguments.message === "team"
      ? positive() : say('{"inScope":false,"reason":"对象不同"}'), true);
  f.app.settings.set("on");
  await f.start();
  const outside = await f.park("outbox_send", "other");
  expect(outside.statement).toEqual([{ ...first, isNew: false }, { ...extra, isNew: false }]);
  expect(f.judged.map(j => j.statement)).toEqual([[first], [first, extra], [first, extra]]);
  expect(f.app.demo.outbox).toEqual(["team", "team"]);
  expect(f.surface.snapshot().ledger[0]?.summary).toContain("审批模型放行");
  await f.decide(outside.id, "once");
  const irreversible = await f.park("fixture_delete");
  expect(f.deletes()).toBe(0);
  expect(f.judged).toHaveLength(3);
  await f.decide(irreversible.id, "deny");
  await expect.poll(() => f.surface.snapshot().tasks[0]?.status).toBe("completed");
  expect(f.deletes()).toBe(0);
  const { approvals } = await stats("day", f.app.timeZone, { app: f.app, dir: f.dir! });
  expect(approvals).toMatchObject({ userDecisions: { once: 1, deny: 1, "task-full": 0 },
    byApprover: [{ approver: "user", count: 2 }, { approver: "judge", count: 2 }, { approver: "timeout", count: 0 }] });
});

it("honors task-full for subsequent irreversible operations even with the model off", async () => {
  const f = await setup([send(), call("fixture_delete", {}), finish]);
  f.app.settings.set("off");
  await f.start();
  await f.decide((await f.park()).id, "task-full");
  await expect.poll(f.deletes).toBe(1);
  expect(f.judged).toEqual([]);
});

it("keeps a deferred approval across restart and consumes it once for matching arguments", async () => {
  const results: string[] = [];
  const f = await setup([declare(), send(), ctx => {
    results.push(contentText(ctx.messages.at(-1)!.content));
    return call("fixture_delete", {});
  }, send("other"), send(), send(), finish], say('{"inScope":false,"reason":"待确认"}'), true);
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
  await g.decide((await g.park("outbox_send", "other")).id, "once");
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

it("asks directly when the worker has no statement", async () => {
  let result = "";
  const f = await setup([send(), ctx => { result = contentText(ctx.messages.at(-1)!.content); return finish; }]);
  f.app.settings.set("on");
  await f.start();
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
  const f = await setup([declare(), send(), call("fixture_delete", {}), send(), finish], positive, true);
  f.app.settings.set("on");
  await f.start();
  const held = await f.park("fixture_delete");
  await f.close();
  const g = await f.reopen();
  g.app.harness.resume();
  await g.decide(held.id, "once");
  await expect.poll(() => g.surface.snapshot().tasks[0]?.status).toBe("completed");
  expect(g.app.demo.outbox).toEqual(["team"]);
  expect(f.judged.map(j => j.statement)).toEqual([[first], [first]]);
  expect(g.surface.snapshot().ledger.map(row => row.summary)).toEqual([expect.stringContaining("审批模型放行"), expect.stringContaining("审批模型放行"), "done"]);
});

it("uses only the last three original user inputs for both the lease and its write", async () => {
  const f = await setup([]);
  const texts = ["旧指示", "给团队写更新", "只发本周进度", "现在发送"];
  f.mainModel.setResponses([say("模型回复"), say("模型回复"), say("模型回复"), say("系统唤醒"),
    call("enable_tool", { capability: "outbox", reason: "模型写的理由" }), send(), say("完成")]);
  for (const text of texts.slice(0, 3)) {
    await submitMessage(f.app.main, text);
    await f.app.main.waitForIdle(context);
  }
  await submitMessage(f.app.main, "内部调度内容", "schedule");
  await f.app.main.waitForIdle(context);
  await f.app.main.commit(tx => tx.appendEntry(f.app.main.id, {
    kind: "alter.task-report", data: { source: "web", text: "工具执行结果和任务报告" },
  }), context);
  await submitMessage(f.app.main, texts[3]!);
  await f.app.main.waitForIdle(context);
  expect(f.app.demo.outbox).toEqual(["team"]);
  expect(f.judged.map(j => j.call.tool)).toEqual(["enable_tool", "outbox_send"]);
  for (const { statement } of f.judged) {
    expect(statement).toEqual(texts.slice(1).map(purpose => ({ tool: "", target: "", purpose })));
  }
  expect(await approvalStats(f.app.main)).toEqual({ modelAllowed: 2, askedUser: 0, userApproved: 0, userDenied: 0 });
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
  const f = await setup([declare({ tool, target: "fixture", purpose: "remove" }), call(tool, {}), finish]);
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
