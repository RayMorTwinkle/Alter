import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import { chatCommand, observeChat } from "../src/cli.ts";
import { openAlter } from "../src/main.ts";
import { Notifications } from "../src/notifications.ts";
import { defaultCompactAtTokens } from "../src/settings.ts";
import { compactionSettings } from "../src/compaction.ts";
import { resolveCapabilities } from "../src/model-capabilities.ts";
import { gatewayCapabilities, createGatewayModels } from "../src/models.ts";
import { context, MemoryStorage, openNodeSqliteStorage } from "../src/runtime.ts";
import { stats } from "../src/stats.ts";
import { Tasks } from "../src/state.ts";
import { appendUsage, usageSummary, type UsageLine } from "../src/usage.ts";
import { delta, fakeGateway, httpError, say, toolCall } from "./fixtures/gateway.ts";

const primary = "shared/primary";
const backup = "backup/main";
const taskBackup = "backup/task";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function setup(route: Parameters<typeof fakeGateway>[0], timeout = 2000, main = [primary, backup]) {
  const server = await fakeGateway(route);
  cleanup.push(() => server.close());
  const dir = await mkdtemp(join(tmpdir(), "alter-gateway-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const config = gatewayConfig({ ALTER_LLM_BASE_URL: server.baseUrl, ALTER_LLM_API_KEY: "offline-key",
    ALTER_MAIN_MODEL: main.join(", "), ALTER_TASK_MODEL: [primary, taskBackup].join(","),
    ALTER_DATA_DIR: dir, ALTER_FIRST_TOKEN_TIMEOUT_MS: String(timeout) });
  const { models, mainModel, taskModel, thinking } = await createGatewayModels(config);
  const model = models.getModel(mainModel.provider, mainModel.modelId)!;
  const input = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };
  return {
    models, mainModel, taskModel, thinking, requests: server.requests, dir,
    stream: (signal?: AbortSignal) => models.streamSimple(model, input, { signal }),
    async logs(): Promise<UsageLine[]> {
      return (await readFile(join(dir, "usage.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    },
  };
}

it.each([
  [500, "server"], [503, "server"], [429, "rate_limit"], [401, "auth"], [403, "auth"],
  ["reset", "network"], ["no headers", "timeout"], ["role only", "timeout"],
] as const)("falls back before output on %s and records both attempts", async (failure, errorKind) => {
  const app = await setup(({ model }, res) => {
    if (model === backup) return say(res, "回答");
    if (typeof failure === "number") return httpError(res, failure);
    if (failure === "reset") res.destroy();
    if (failure === "role only") delta(res, { role: "assistant", content: "" });
    // Keep the socket open for either timeout case.
  }, failure === "no headers" || failure === "role only" ? 300 : 2000);
  const events = [];
  const stream = app.stream();
  for await (const event of stream) events.push(event.type);
  expect(events).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
  expect(await stream.result()).toMatchObject({ model: backup, content: [{ type: "text", text: "回答" }] });
  const [a, b] = app.requests;
  expect(app.requests).toHaveLength(2);
  expect(a).toMatchObject({ stream: true, model: primary });
  expect(b).toEqual({ ...a, model: backup });
  const logs = await app.logs();
  expect(logs).toHaveLength(2);
  expect(logs[0]).toEqual({ at: expect.any(String), conversation: "main", role: "main", thinking: "off", tools: [], costUsd: null, retry: 0, fallback: false, model: primary, attempt: 1,
    outcome: "error", errorKind, latencyMs: expect.any(Number) });
  expect(logs[1]).toEqual({ at: expect.any(String), conversation: "main", role: "main", thinking: "off", tools: [], costUsd: null, retry: 0, fallback: true, input: 6, cacheRead: 2, cacheWrite: 0, model: backup, attempt: 2, fallbackFrom: primary,
    outcome: "ok", latencyMs: expect.any(Number), firstTokenMs: expect.any(Number), inputTokens: 8, outputTokens: 3 });
  expect(new Date(logs[0]!.at).toISOString()).toBe(logs[0]!.at);
  expect(logs[1]!.latencyMs).toBeGreaterThanOrEqual(logs[1]!.firstTokenMs!);
});

it.each([
  ["text", { content: "half an answer" }],
  ["thinking", { reasoning_content: "considering" }],
  ["tool", { tool_calls: [{ index: 0, id: "call1", function: { name: "finish", arguments: "{" } }] }],
] as const)("preserves partial %s output without switching on disconnect", async (_, partial) => {
  const app = await setup((_body, res) => {
    delta(res, partial);
    setTimeout(() => res.destroy(), 25);
  });
  expect(await app.stream().result()).toMatchObject({ model: primary, stopReason: "error", content: [expect.anything()] });
  expect(app.requests.map(r => r.model)).toEqual([primary]);
  expect(await app.logs()).toMatchObject([{ outcome: "error", firstTokenMs: expect.any(Number) }]);
});

it("stops the deadline at first output, even for a slow completion", async () => {
  const app = await setup((_body, res) => {
    delta(res, { content: "first" });
    setTimeout(() => say(res, "last"), 300);
  }, 150);
  expect(await app.stream().result()).toMatchObject({ stopReason: "stop", content: [{ text: "firstlast" }] });
  expect(app.requests).toHaveLength(1);
});

it("exhausts the chain once in order and aggregates failures and incoming fallbacks", async () => {
  const last = "third/model";
  const app = await setup((_body, res) => httpError(res, 503), 2000, [primary, backup, last]);
  const runtime = await openAlter(new MemoryStorage(), app.models, app.mainModel, app.taskModel);
  cleanup.push(() => runtime.harness.close(context));
  const sub = await runtime.main.submit({ type: "input", content: "hello" }, context);
  expect((await sub.wait(context)).status).toBe("unanswered");
  expect(app.requests.map(r => r.model)).toEqual([primary, backup, last]);
  expect((await app.logs()).map(l => l.fallbackFrom)).toEqual([undefined, primary, backup]);
  expect(await usageSummary(app.dir)).toEqual([primary, backup, last].map((model, index) => ({
    model, calls: 1, failureRate: "100.0%", aborted: 0, fallbacks: index ? 1 : 0, inputTokens: 0, outputTokens: 0,
    p50Ms: expect.any(Number), p95Ms: expect.any(Number),
  })));
});

it("distinguishes a configured same-model retry from switching models", async () => {
  let calls = 0;
  const app = await setup((_, res) => ++calls === 1 ? httpError(res, 429) : say(res, "ok"), 2000, [primary, primary]);
  await app.stream().result();
  expect(await app.logs()).toMatchObject([{ model: primary, fallback: false, retry: 0 }, { model: primary, fallback: false, retry: 1 }]);
  expect(await usageSummary(app.dir)).toMatchObject([{ calls: 2, fallbacks: 1 }]);
});

it("surfaces a bad request without fallback", async () => {
  const app = await setup((_body, res) => httpError(res, 400));
  expect(await app.stream().result()).toMatchObject({ model: primary, stopReason: "error" });
  expect(await app.logs()).toMatchObject([{ outcome: "error", errorKind: "http" }]);
  expect(app.requests).toHaveLength(1);
});

it("propagates caller cancellation without fallback", async () => {
  const app = await setup((_body, res) => delta(res, { role: "assistant" }));
  const controller = new AbortController();
  const stream = app.stream(controller.signal);
  await expect.poll(() => app.requests.length).toBe(1);
  controller.abort();
  expect(await stream.result()).toMatchObject({ model: primary, stopReason: "aborted" });
  expect(await app.logs()).toMatchObject([{ outcome: "error", errorKind: "aborted" }]);
  expect(app.requests).toHaveLength(1);
});

it.each(["fresh", "fork"])("routes a %s child separately and delivers approvals and reports to the idle REPL", async mode => {
  const app = await setup(({ model, messages }, res) => {
    if (model === primary) return httpError(res, 429);
    const last = messages.at(-1)!;
    if (model === taskBackup) {
      if (last.role === "tool") return toolCall(res, "finish", { summary: "已处理", refs: [] });
      return toolCall(res, "outbox_send", { message: "hello" });
    }
    if (last.content?.endsWith("\ndelegate")) return toolCall(res, "dispatch_task", { brief: "send", context: mode, permission: "auto" });
    if (last.content.includes("finished:")) return say(res, "收到报告");
    say(res, "内部草稿");
  });
  const storage = () => mode === "fresh" ? new MemoryStorage() : openNodeSqliteStorage(join(app.dir, "main.sqlite"));
  const open = async () => {
    const runtime = await openAlter(await storage(), app.models, app.mainModel, app.taskModel);
    runtime.settings.set("off");
    cleanup.push(() => runtime.harness.close(context));
    return runtime;
  };
  let runtime = await open();
  const lines: string[] = [];
  const print = (text: string) => lines.push(text);
  const attach = async () => {
    const detach = await observeChat(runtime, print);
    cleanup.push(async () => detach());
    runtime.harness.resume();
  };
  await attach();
  await chatCommand(runtime, "delegate", print);
  await expect.poll(() => lines.some(l => l.startsWith("[用户审批]"))).toBe(true);
  const id = lines.find(l => l.startsWith("[用户审批]"))!.match(/permission-\d+/)![0];
  if (mode === "fork") {
    await runtime.main.waitForIdle(context);
    // M0 persisted a single model ref. Neither conversation may use that stale ref after reopening.
    const tasks = await runtime.harness.snapshot(Tasks, runtime.main.id, context);
    const child = await runtime.harness.conversation(Object.values(tasks!.byId)[0]!.conversationId, context);
    const legacy = { model: { provider: "faux", modelId: "faux-1" } };
    await runtime.main.configure(legacy, context);
    await child!.configure(legacy, context);
    await runtime.harness.close(context);
    lines.length = 0;
    runtime = await open();
    await attach();
    expect(lines[0]).toContain(`[用户审批] ${id}`);
  }
  await chatCommand(runtime, "/tasks", print);
  expect(lines.at(-1)).toContain('"status": "running"');
  const allow = mode === "fresh";
  await chatCommand(runtime, `/${allow ? "approve" : "deny"} ${id} my note`, print);
  await expect.poll(() => lines.includes("Alter> 收到报告")).toBe(true);
  await runtime.main.waitForIdle(context);
  expect(lines.filter(l => l.startsWith("[回投]"))).toEqual([expect.stringMatching(/finished: 已处理/)]);
  expect(lines.filter(l => l.startsWith("[用户审批]"))).toHaveLength(1);
  expect(runtime.demo.outbox).toEqual(allow ? ["hello"] : []);
  const logs = await app.logs();
  expect(logs.some(line => line.conversation === "judge")).toBe(false);
  for (const conversation of ["main", "task"] as const) {
    const uses = logs.filter(l => l.conversation === conversation);
    expect(uses.map(l => l.model)).toEqual(Array(conversation === "main" ? 3 : 2).fill([primary, conversation === "main" ? backup : taskBackup]).flat());
  }
  const children = runtime.traces.list({ conversation: "task" }).items;
  expect(children.map(row => row.model)).toEqual([taskBackup, primary, taskBackup, primary]);
  expect(runtime.traces.detail(children[0]!.id)).toMatchObject({ attempt: 2, fallback: true, fallbackFrom: primary,
    output: { content: [{ type: "toolCall", name: "finish" }] }, toolResults: [{ name: "finish", isError: false, text: "已处理" }] });
  expect(runtime.traces.detail(children[1]!.id)).toMatchObject({ attempt: 1, fallback: false, isError: true, output: { stopReason: "error" } });
  const mainCalls = logs.filter(l => l.role === "main");
  expect(runtime.traces.list({ trigger: "report" }).items).toHaveLength(mainCalls.filter(l => l.wakeSource === "report").length);
  const taskCalls = logs.filter(l => l.role === "task");
  expect(mainCalls.map(l => l.wakeSource)).toEqual(["user-cli", "user-cli", "user-cli", "user-cli", "report", "report"]);
  expect(new Set(mainCalls.map(l => l.wakeId)).size).toBe(2);
  expect(taskCalls.every(l => l.taskId?.startsWith("task-") && l.wakeId === mainCalls[0]!.wakeId)).toBe(true);
  const entries = await runtime.main.entries({}, 100, undefined, context);
  expect(entries.items.flatMap(e => e.model ?? []).filter(m => m.role === "assistant").map(m => m.model)).toEqual([backup, backup, backup]);
  const summary = await usageSummary(app.dir);
  const legacy = await stats("all", runtime.timeZone, { app: runtime, dir: join(app.dir, "no-usage") });
  expect(legacy.tasks.items).toMatchObject([{ usageSource: "transcript", rounds: 2, models: [taskBackup],
    tools: { outbox_send: 1, finish: 1 }, usage: { calls: 2, tokens: 22, costUsd: null } }]);
  expect(legacy.total.calls).toBe(0);
  expect(summary.find(row => row.model === backup)).toMatchObject({ calls: 3, fallbacks: 3, failureRate: "0.0%", inputTokens: 24, outputTokens: 9 });
});

it.each([false, true])("prints a queued report once when the in-flight answer already relays it=%s", async relayed => {
  let reportCalls = 0;
  let release: ServerResponse | undefined;
  const app = await setup(({ messages, tools }, res) => {
    const last = messages.at(-1)!;
    if (tools?.some(t => t.function.name === "finish")) {
      return toolCall(res, "finish", { summary: "ready", refs: [] });
    }
    if (last.content?.endsWith("\ndelegate")) {
      return toolCall(res, "dispatch_task", { brief: "report", context: "fresh", permission: "restricted" });
    }
    if (last.role === "tool") {
      release = res; return;
    }
    reportCalls++;
    const alreadyHandled = last.content.includes("只汇报用户尚未获知的结果") && messages.some(m => m.role === "assistant" && JSON.stringify(m).includes("ready"));
    if (alreadyHandled) return say(res, "");
    say(res, "handled");
  });
  const runtime = await openAlter(new MemoryStorage(), app.models, app.mainModel, app.taskModel);
  cleanup.push(() => runtime.harness.close(context));
  const lines: string[] = [];
  const print = (s: string) => lines.push(s);
  const detach = await observeChat(runtime, print);
  cleanup.push(async () => detach());
  await chatCommand(runtime, "delegate", print);
  await expect.poll(() => release !== undefined && lines.some(s => s.startsWith("[回投]"))).toBe(true);
  say(release!, relayed ? "ready" : "dispatched");
  await runtime.main.waitForIdle(context);
  expect(reportCalls).toBe(1);
  expect(lines.filter(s => s.startsWith("Alter>"))).toEqual(relayed ? ["Alter> ready"] : ["Alter> dispatched", "Alter> handled"]);
  expect(lines.filter(s => s.startsWith("[回投]"))).toHaveLength(1);
});

it("summarizes nearest-rank latency and failure rate over all attempts for a model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-summary-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  expect(await usageSummary(dir)).toEqual([]);
  for (const latencyMs of [45, 80, 10, 5, 21]) {
    await appendUsage(dir, { at: new Date().toISOString(), model: primary, conversation: "main", attempt: 1,
      outcome: latencyMs === 80 ? "error" : "ok", latencyMs });
  }
  expect(await usageSummary(dir)).toMatchObject([{ calls: 5, failureRate: "20.0%", p50Ms: 21, p95Ms: 80 }]);
});

it("counts user aborts separately from provider failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-usage-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const base = { at: new Date().toISOString(), conversation: "main", model: "m", attempt: 1, latencyMs: 5 } as const;
  await appendUsage(dir, { ...base, outcome: "ok" });
  await appendUsage(dir, { ...base, outcome: "error", errorKind: "aborted" });
  await appendUsage(dir, { ...base, outcome: "error", errorKind: "server" });
  expect(await usageSummary(dir)).toMatchObject([{ model: "m", calls: 3, aborted: 1, failureRate: "33.3%" }]);
});

it.each([[undefined, "high"], ["medium", "medium"], ["max", "high"]] as const)("records and sends the effective task reasoning effort (%s)", async (thinking, effective) => {
  const app = await setup(({ messages, tools }, res) => {
    const last = messages.at(-1)!;
    if (tools?.some(t => t.function.name === "finish")) return toolCall(res, "finish", { summary: "done", refs: [] });
    if (last.content === "delegate") {
      return toolCall(res, "dispatch_task", { brief: "work", context: "fresh", permission: "full", thinking });
    }
    say(res, "ok");
  });
  expect(app.thinking).toEqual({ main: "medium", task: "high" });
  const runtime = await openAlter(new MemoryStorage(), app.models, app.mainModel, app.taskModel, app.thinking);
  cleanup.push(() => runtime.harness.close(context));
  await (await runtime.main.submit({ type: "input", content: "delegate" }, context)).wait(context);
  await expect.poll(() => app.requests.some(r => r.tools?.some(t => t.function.name === "finish"))).toBe(true);
  const isTask = (r: { tools?: { function: { name: string } }[] }) => r.tools?.some(t => t.function.name === "finish");
  expect(new Set(app.requests.filter(r => !isTask(r)).map(r => r.reasoning_effort))).toEqual(new Set(["medium"]));
  expect(new Set(app.requests.filter(isTask).map(r => r.reasoning_effort))).toEqual(new Set([effective]));
  expect(Object.values((await runtime.harness.snapshot(Tasks, runtime.main.id, context))!.byId)[0]?.thinking).toBe(effective);
});

it("rejects an unknown thinking level", () => {
  expect(() => gatewayConfig({ ALTER_LLM_BASE_URL: "http://x/v1", ALTER_LLM_API_KEY: "k", ALTER_MAIN_MODEL: "a/b",
    ALTER_TASK_MODEL: "a/b", ALTER_MAIN_THINKING: "extreme" })).toThrow(/ALTER_MAIN_THINKING/);
});

it("reads the configurable approval timeout in minutes", () => {
  const env = { ALTER_LLM_BASE_URL: "http://x/v1", ALTER_LLM_API_KEY: "k", ALTER_MAIN_MODEL: "a/b", ALTER_TASK_MODEL: "a/b" };
  expect(gatewayConfig(env).approvalTimeoutMs).toBe(86_400_000);
  expect(gatewayConfig({ ...env, ALTER_APPROVAL_TIMEOUT_MINUTES: "0.5" }).approvalTimeoutMs).toBe(30_000);
  for (const value of ["0", "-1", "never", "Infinity"]) {
    expect(() => gatewayConfig({ ...env, ALTER_APPROVAL_TIMEOUT_MINUTES: value })).toThrow(/ALTER_APPROVAL_TIMEOUT_MINUTES/);
  }
});

it("uses Shanghai as the default time zone and reads ALTER_TZ", () => {
  const env = { ALTER_LLM_BASE_URL: "http://x/v1", ALTER_LLM_API_KEY: "k", ALTER_MAIN_MODEL: "a/b", ALTER_TASK_MODEL: "a/c" };
  expect(gatewayConfig(env).timeZone).toBe("Asia/Shanghai");
  expect(gatewayConfig({ ...env, ALTER_TZ: " America/New_York " }).timeZone).toBe("America/New_York");
});

it("accounts for a single tool-free task-model attempt per event, including gateway errors", async () => {
  let count = 0;
  const f = await setup((_, res) => ++count === 1 ? say(res, '{"level":"digest","reason":"请尽快查看"}') : httpError(res, 503));
  const runtime = await openAlter(new MemoryStorage(), f.models, f.mainModel, f.taskModel);
  cleanup.push(runtime.close);
  for (const ref of ["one", "two"]) {
    await runtime.events.emit({ source: "mail", ref, kind: "new-message", summary: "会议改期", at: 123, untrusted: true });
  }
  await expect.poll(async () => (await runtime.harness.snapshot(Notifications, runtime.main.id, context))?.entries[0]?.ref).toBe("two");
  expect(f.requests.map(r => r.model)).toEqual([primary, primary]);
  expect(f.requests.every(r => !r.tools?.length)).toBe(true);
  expect(await f.logs()).toMatchObject([
    { conversation: "triage", model: primary, attempt: 1, outcome: "ok", inputTokens: 8, outputTokens: 3 },
    { conversation: "triage", model: primary, attempt: 1, outcome: "error" },
  ]);
  expect((await runtime.harness.snapshot(Notifications, runtime.main.id, context))?.entries[0]?.level).toBe("digest");
});

it("keeps goals available to heartbeat without launching a daily research worker", async () => {
  const f = await setup((_, res) => say(res, "ok"));
  let now = Date.parse("2026-12-01T00:59Z");
  const app = await openAlter(new MemoryStorage(), f.models, f.mainModel, f.taskModel, {}, { timeZone: "Asia/Taipei", now: () => now });
  cleanup.push(app.close);
  app.memory.save({ kind: "goal", text: "备考" });
  now += 60_000;
  app.harness.resume();
  await expect.poll(() => app.harness.wake().active).toBe(false);
  expect((await app.scheduler.list()).some(s => s.kind === "goal-review")).toBe(false);
  expect(app.memory.list()).toMatchObject([{ kind: "goal", text: "备考" }]);
  expect(f.requests).toHaveLength(0);
});

it("resolves exact, aliased and cross-provider catalog entries before defaults", () => {
  const exact = resolveCapabilities("opencode-go/glm-5.3");
  expect(exact).toMatchObject({ contextWindow: 1_000_000, maxTokens: 131072, reasoning: true, input: ["text"],
    thinkingLevelMap: { low: "low", high: "high", max: "max", medium: null }, sources: { input: "catalog" } });
  expect(resolveCapabilities("codex/gpt-6.2-astra")).toMatchObject({ contextWindow: 272000, thinkingLevelMap: { minimal: "low" } });
  expect(resolveCapabilities("other/glm-5.3")).toMatchObject({ contextWindow: 1_000_000, input: ["text"], sources: { maxTokens: "catalog" } });
  expect(resolveCapabilities(primary)).toMatchObject({ contextWindow: 65536, maxTokens: 4096, input: ["text", "image"],
    thinkingLevelMap: null, sources: { reasoning: "default", thinkingLevelMap: "default" } });
});

it("merges chain limits, persists overrides and sends each fallback's own reasoning format and output budget", async () => {
  const deepseek = "opencode-go/deepseek-v4.1-flash";
  const glm = "opencode-go/glm-5.3";
  const app = await setup(({ model }, res) => model === deepseek ? httpError(res, 503) : say(res, "ok"), 2000, [deepseek, glm]);
  const chain = () => app.models.getModel("alter-main", "chain")!;
  const caps = gatewayCapabilities.get(app.models)!;
  expect(chain()).toMatchObject({ input: ["text"], contextWindow: 1_000_000, maxTokens: 131072, thinkingLevelMap: { medium: null } });
  const ctx = { messages: [{ role: "user" as const, timestamp: 1, content: [
    { type: "text" as const, text: "help" }, { type: "image" as const, mimeType: "image/png", data: "AA==" },
  ] }] };
  expect((await app.models.completeSimple(chain(), ctx, { reasoning: "high" })).stopReason).toBe("stop");
  expect(app.requests.map(r => r.model)).toEqual([deepseek, glm]);
  for (const request of app.requests) {
    expect(request).not.toHaveProperty("max_tokens");
    expect(JSON.stringify(request.messages)).not.toContain("image_url");
  }
  expect(app.requests[0]).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high" });
  expect(app.requests[1]).toMatchObject({ reasoning_effort: "high" });
  expect(app.requests[1]).not.toHaveProperty("thinking");
  await app.models.completeSimple(chain(), ctx, { maxTokens: 80 });
  expect(app.requests.at(-1)).toHaveProperty("max_tokens", 80);
  expect(caps.replace(glm, { contextWindow: 64_000, maxTokens: 7600, input: ["text", "image"] })).toMatchObject({
    sources: { contextWindow: "manual", maxTokens: "manual", input: "manual", reasoning: "catalog" },
  });
  expect(chain()).toMatchObject({ contextWindow: 64_000, maxTokens: 7600, input: ["text", "image"] });
  await app.models.completeSimple(chain(), ctx);
  expect(app.requests.at(-1)).toHaveProperty("max_tokens", 7600);
  expect(JSON.stringify(app.requests.at(-1)!.messages)).toContain("image_url");
  const restored = await createGatewayModels(gatewayConfig({ ALTER_LLM_BASE_URL: "http://localhost", ALTER_LLM_API_KEY: "offline-key",
    ALTER_MAIN_MODEL: glm, ALTER_TASK_MODEL: glm, ALTER_DATA_DIR: app.dir }));
  expect(restored.models.getModel("alter-task", "chain")).toMatchObject({ contextWindow: 64_000 });
  const policy = (threshold = defaultCompactAtTokens) => compactionSettings(app.models, [app.mainModel], threshold);
  expect(policy().modelOverrides["alter-main/chain"]?.reserveTokens).toBe(4000);
  caps.replace(glm, {});
  expect(policy()).toMatchObject({ modelOverrides: { "alter-main/chain": { reserveTokens: 600_000, backgroundTokens: 4096 } } });
  expect(policy(300_000).modelOverrides["alter-main/chain"]?.reserveTokens).toBe(700_000);
});
