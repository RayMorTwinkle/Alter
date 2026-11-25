import { context } from "@alter/core";
import { expect, it } from "vitest";
import { say, toolCall } from "../../core/test/fixtures/gateway.ts";
import type { DebugPrompt, DebugSchedule, DebugTrace, DebugTracePage } from "../../web/src/types.ts";
import { setup } from "./web-fixture.ts";

it("requires login on all debug routes and reconstructs the actual gateway request and matching tool result", async () => {
  const requests: { messages: unknown[]; tools?: { function: unknown }[] }[] = [];
  const web = await setup((body, res) => {
    requests.push(body);
    if (requests.length === 1) toolCall(res, "schedule_list", {});
    else say(res, "已检查");
  });
  for (const path of ["traces", "traces/1", "prompts/hash", "schedule"]) {
    expect((await web.read("/api/debug/" + path)).status).toBe(401);
  }
  await web.login();
  await web.post("/api/messages", { text: "查看安排" });
  await web.app.main.waitForIdle(context);
  const response = await web.read("/api/debug/traces?conversation=main&trigger=user-web&limit=1");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const page: DebugTracePage = await response.json();
  expect(page.items).toMatchObject([{ model: "offline/main", trigger: "user-web", tokens: { input: 6, cacheRead: 2, output: 3 }, toolCallCount: 0 }]);
  expect(page.nextCursor).toBeTruthy();
  const older: DebugTracePage = await (await web.read("/api/debug/traces?before=" + page.nextCursor)).json();
  expect(older.items).toHaveLength(1);
  const readTrace = async (id: number): Promise<DebugTrace> => (await web.read("/api/debug/traces/" + id)).json();
  const first = await readTrace(older.items[0]!.id);
  const second = await readTrace(page.items[0]!.id);
  for (const [index, trace] of [first, second].entries()) {
    expect(trace).toMatchObject({ format: "gateway", messages: requests[index]!.messages, tools: requests[index]!.tools!.map(t => t.function) });
    expect(trace.messages).toEqual(requests[index]!.messages);
    const prompt: DebugPrompt = await (await web.read("/api/debug/prompts/" + trace.promptHash)).json();
    expect(prompt).toEqual({ hash: trace.promptHash, kind: "system", content: trace.systemPrompt });
  }
  expect(first.promptHash).toEqual(second.promptHash);
  expect(await (await web.read("/api/debug/prompts/" + first.toolsHash)).json()).toEqual({ hash: first.toolsHash, kind: "tools", content: first.tools });
  expect(first).toMatchObject({ entryId: expect.any(Number), entryKind: "alter.user-input", toolCallCount: 1, output: { content: [{ type: "toolCall", name: "schedule_list" }] },
    toolResults: [{ name: "schedule_list", toolCallId: "call_schedule_list", text: "[]", truncated: false, isError: false }] });
  expect(second.output?.content).toEqual([{ type: "text", text: "已检查" }]);
  expect(await (await web.read("/api/debug/traces?trigger=heartbeat")).json()).toEqual({ items: [], nextCursor: null });
  expect((await web.read("/api/debug/traces?limit=0")).status).toBe(400);
  expect((await web.read("/api/debug/traces?before=oops")).status).toBe(400);
  expect((await web.read("/api/debug/traces/999999")).status).toBe(404);
  expect((await web.read("/api/debug/prompts/missing")).status).toBe(404);
  const view: DebugSchedule = await (await web.read("/api/debug/schedule")).json();
  expect(view.report.reason).toContain("活跃");
  expect(view.heartbeat.current.reason).toContain("采纳率");
  expect(view.memory).toMatchObject({ turns: 1, idleMs: 1800000 });
  expect(view.watch.pollMs).toBe(60000);
});
