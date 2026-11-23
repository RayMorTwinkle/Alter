import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { contentText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as say, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it } from "vitest";
import { runScenario } from "../evals/lease-vs-dispatch.ts";
import { openAlter } from "../src/main.ts";
import { context, MemoryStorage } from "../src/runtime.ts";
import { appendUsage } from "../src/usage.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "alter-eval-"));
  dirs.push(dir);
  return dir;
}
function call(tool: string, args: Parameters<typeof fauxToolCall>[1]) {
  return say(fauxToolCall(tool, args), { stopReason: "toolUse" });
}
const mainModel = { provider: "faux", modelId: "faux-1" };

it("removes only the lease tool and lease instruction when leasing is disabled", async () => {
  const models = createModels();
  const faux = fauxProvider();
  faux.setResponses([say("ok"), say("ok")]);
  models.setProvider(faux.provider);
  async function agent(leasing: boolean) {
    const app = await openAlter(new MemoryStorage(), models, mainModel, undefined, {}, { leasing });
    try {
      await app.main.submit({ type: "input", content: "test" }, context);
      await app.main.waitForIdle(context);
      const agent = await app.main.agent(context);
      const messages = (await app.main.context(context)).messages;
      const index = messages.find(m => m.role === "system")?.sections?.["memory-index"];
      return { tools: agent.tools, instructions: agent.instructions + (index ?? "") };
    }
    finally { await app.close(); }
  }
  const lease = await agent(true);
  const dispatch = await agent(false);
  expect(dispatch.tools.map(tool => tool.name)).toEqual(["schedule_create", "schedule_list", "schedule_set", "notify", "feedback_answer", "watch", "watch_list", "watch_cancel",
    "dispatch_task", "task_status", "task_message", "task_stop",
    "memory_read", "memory_search", "memory_write", "memory_delete"]);
  expect(dispatch.instructions).toBe(lease.instructions!.replace("一两步、结果短、需要对话上下文或用户正在等时，用 enable_tool 写明理由自己租用；可指定 action 单租只读工具。", ""));
});

it("leases once and renames the same calendar event across three user turns", async () => {
  const dataDir = await directory();
  const models = createModels();
  const faux = fauxProvider();
  let id = "";
  faux.setResponses([
    call("enable_tool", { capability: "calendar", reason: "建日程" }), call("calendar_create", { title: "站会" }),
    ({ messages }) => { id = contentText(messages.at(-1)!.content); return say("已创建"); },
    () => call("calendar_update", { id, title: "晨会" }), say("已修改"),
    () => call("calendar_update", { id, title: "晨会（10:00）" }), say("已修改"),
  ]);
  models.setProvider(faux.provider);
  const start = performance.now();
  const result = await runScenario({ dataDir, models, mainModel, scenario: "rename-twice", mode: "lease" });
  expect(result).toMatchObject({ correct: true, failure: null, tools: { enable_tool: 1, dispatch_task: 0 } });
  expect(performance.now() - start - result.latencyMs).toBeGreaterThanOrEqual(2999);
});

it("waits for the dispatched list and its final reply, and counts usage attempts by role", async () => {
  const dataDir = await directory();
  const models = createModels();
  const main = fauxProvider();
  const task = fauxProvider({ provider: "worker" });
  const base = { at: new Date().toISOString(), attempt: 1, latencyMs: 10 } as const;
  main.setResponses([
    call("dispatch_task", { brief: "列出日程", context: "fresh", permission: "restricted" }),
    say("正在查询"), async ({ messages }) => {
      await appendUsage(dataDir, { ...base, model: "main", conversation: "main", outcome: "ok", inputTokens: 7, outputTokens: 2 });
      return say(contentText(messages.at(-1)!.content));
    },
  ]);
  task.setResponses([call("calendar_list", {}), async ({ messages }) => {
    await sleep(1100);
    await appendUsage(dataDir, { ...base, model: "task", conversation: "task", outcome: "error", errorKind: "aborted" });
    await appendUsage(dataDir, { ...base, model: "task", conversation: "task", outcome: "ok", inputTokens: 3, outputTokens: 1 });
    return call("finish", { summary: contentText(messages.at(-1)!.content), refs: [] });
  }]);
  models.setProvider(main.provider);
  models.setProvider(task.provider);
  const result = await runScenario({ dataDir, models, mainModel, taskModel: { provider: "worker", modelId: "faux-1" },
    scenario: "list", mode: "dispatch" });
  expect(result).toMatchObject({ correct: true, failure: null, tools: { enable_tool: 0, dispatch_task: 1 }, usage: {
    main: { input: 7, output: 2, tokens: 9, calls: 1, aborted: 0 },
    task: { input: 3, output: 1, tokens: 4, calls: 2, aborted: 1 },
    total: { input: 10, output: 3, tokens: 13, calls: 3, aborted: 1 },
  } });
  expect(result.latencyMs).toBeGreaterThanOrEqual(1100);
});
