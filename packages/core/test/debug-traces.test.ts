import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { openDebugTraces, traceInput } from "../src/debug-traces.ts";
import { intervalDecision } from "../src/heartbeat.ts";

it("shares prompts and messages across calls, retains result ownership and prunes orphan content on reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-debug-"));
  const day = 86_400_000;
  let at = 0;
  let store = openDebugTraces(dir, () => at);
  const owner = { conversation: "main" as const, conversationId: "1", trigger: "heartbeat" };
  const tool = { name: "read", description: "lookup", parameters: { type: "object" } };
  const context = { systemPrompt: "instructions", tools: [tool], messages: [{ role: "user" as const, content: "go", timestamp: 0 }] };
  const input = traceInput(context, undefined);
  const output = fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" });
  const record = () => {
    const call = store.request(owner, context);
    call.capture("fake");
    const row = store.list().items[0]!;
    expect(row.outcome).toBe("pending");
    call.complete({ at: new Date(at).toISOString(), model: "fake", outcome: "ok", attempt: 1, latencyMs: 3 }, output);
    return row.id;
  };
  try {
    const first = record();
    const callId = output.content.find(c => c.type === "toolCall")!.id;
    const result = { role: "toolResult" as const, toolName: "read", toolCallId: callId, content: [{ type: "text" as const, text: "字".repeat(21_000) }], isError: true, timestamp: at };
    store.toolResult("1", result);
    expect(store.detail(first)).toMatchObject({ systemPrompt: "instructions", tools: [tool], messages: input.messages, isError: true,
      toolResults: [{ toolCallId: callId, isError: true, truncated: true, text: "字".repeat(20_000) }] });
    at += day;
    const second = record();
    const third = record();
    const page = store.list({ trigger: "heartbeat", limit: 1 });
    expect(page.items.map(row => row.id)).toEqual([third]);
    expect(store.list({ before: page.nextCursor! }).items.map(row => row.id)).toEqual([second, first]);
    expect(store.list({ trigger: "triage" }).items).toEqual([]);
    const hash = String(store.detail(first)!.promptHash);
    expect(store.detail(second)).toMatchObject({ promptHash: hash, toolResults: [] });
    const db = new DatabaseSync(join(dir, "debug.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM content WHERE body LIKE '%instructions%' OR body LIKE '%lookup%'").get()).toEqual({ n: 2 });
      expect(db.prepare("SELECT kind,count(*) AS n FROM content GROUP BY kind ORDER BY kind").all())
      .toEqual([{ kind: "message", n: input.messages.length }, { kind: "system", n: 1 }, { kind: "tools", n: 1 }]);
    } finally { db.close(); }
    at = 15 * day;
    store.close();
    store = openDebugTraces(dir, () => at);
    expect(store.detail(first)).toBeUndefined();
    expect(store.detail(second)).toMatchObject({ messages: input.messages });
    expect(store.prompt(hash)).toEqual({ hash, kind: "system", content: "instructions" });
    at++;
    store.prune();
    expect(store.prompt(hash)).toBeUndefined();
    expect(store.list().items).toEqual([]);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

it("explains the signals, bias and both interval bounds used by the scheduler", () => {
  const low = intervalDecision({ adoptionRate: 0.2, dueGoals: 2, digestCount: 0, userMessages: 0 }, 4);
  expect(low).toMatchObject({ bias: 4, demand: 0.4, clamped: "max", intervalMs: 48 * 3600_000 });
  expect(low.reason).toMatch(/采纳率 20%.*拉长.*2 个到期目标.*缩短.*48 小时上限/);
  const high = intervalDecision({ adoptionRate: 1, dueGoals: 30, digestCount: 50, userMessages: 80 });
  expect(high.demand).toBeCloseTo(2.32);
  expect(high.factor).toBeCloseTo(2 ** (-3.3 - high.demand));
  expect(high).toMatchObject({ clamped: "min", intervalMs: 2 * 3600_000 });
  expect(high.reason).toContain("2 小时下限");
});
