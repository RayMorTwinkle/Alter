import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as say, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { openAlter } from "../src/main.ts";
import { createMemory } from "../src/memory.ts";
import { consolidationThreshold, planConsolidation } from "../src/memory-consolidation.ts";
import { MemoryInbox, recordUserMessage } from "../src/memory-inbox.ts";
import { context, MemoryStorage, openNodeSqliteStorage } from "../src/runtime.ts";
import { submitMessage } from "../src/timeline.ts";

it("searches before each decision, sees staged edits, commits one reversible batch, and detects a concurrent edit", async () => {
  const memory = createMemory(undefined, () => 100, "UTC");
  const close = await memory.start();
  try {
    const old = memory.save({ kind: "profile", text: "咖啡加奶" });
    const source = [{ id: "m1", text: "咖啡不加奶；问题请用中文回答。", at: 90 }];
    const actions = ["add", "modify", "supersede", "keep"];
    const candidates = ["回答方式", "咖啡习惯", "更正咖啡习惯", "咖啡确认"].map(title =>
      ({ type: "preference", title, body: "咖啡不加奶", source: "m1", guess: true }));
    const plan = async () => {
      let step = 0;
      return planConsolidation(memory, source, async (_, input) => {
        if (Array.isArray(input)) return candidates;
        const { matches } = input as { matches: { id: string; title: string }[] };
        const op = actions[step++];
        if (op === "add") return { op };
        if (op === "supersede") expect(matches.find(e => e.id === old)?.title).toBe("咖啡习惯");
        const id = op === "keep" ? matches.find(e => e.title === "更正咖啡习惯")!.id : old;
        expect(matches.map(e => e.id)).toContain(id);
        return { op, id };
      }, 100, "UTC");
    };
    const first = await plan();
    memory.update(old, { body: "用户刚修改" });
    expect(() => memory.store.apply(first.operations, "consolidate", "batch", first.revision)).toThrow("changed during");
    const before = memory.store.view();
    const { operations, revision } = await plan();
    memory.store.apply(operations, "consolidate", "batch", revision);
    expect(memory.store.changes()[0]!.operations.map(o => o.op)).toEqual(actions);
    expect(memory.store.view().entries.every(e => e.guess && e.source === "m1")).toBe(true);
    const change = memory.store.changes()[0]!;
    expect(memory.store.apply(operations, "consolidate", "batch", revision)).toEqual([]);
    expect(memory.store.changes()[0]!.id).toBe(change.id);
    expect(memory.store.undo(change.id)).toBe(true);
    expect(memory.store.view()).toEqual(before);
  } finally { await close(); }
});

it("merges an oversized index even when there are no new candidates", async () => {
  const memory = createMemory(undefined, () => 100, "UTC");
  const close = await memory.start();
  try {
    const ids = memory.store.apply(Array.from({ length: 30 }, (_, i) => ({
      op: "add", entry: { type: "preference", title: "答复格式 " + i, body: "偏好".repeat(45) + i },
    }))).map(change => change.ids[0]!);
    const before = memory.store.view();
    expect(before.needsConsolidation).toBe(true);
    const { operations } = await planConsolidation(memory, [{ id: "m", at: 2, text: "谢谢" }],
      async instruction => instruction.includes("必须合并") ? [{ ids, type: "preference", title: "共同偏好", body: "偏好短答" }] : [], 100, "UTC");
    memory.store.apply(operations, "consolidate");
    expect(memory.store.view()).toMatchObject({ needsConsolidation: false, entries: [{ title: "共同偏好" }] });
    expect(memory.store.read(ids[0]!)?.supersededBy).toBeDefined();
    memory.store.undo(memory.store.changes()[0]!.id);
    expect(memory.store.view()).toEqual(before);
  } finally { await close(); }
});

it("waits for both 200 user turns and 30 idle minutes and sends only own messages to a low-thinking model", async () => {
  expect(consolidationThreshold()).toBe(250);
  for (const invalid of [199, 301, 250.5]) expect(() => consolidationThreshold(invalid)).toThrow();
  let at = Date.parse("2026-12-01T12:00Z");
  const timers = new Map<() => void, number>();
  const advance = (ms: number) => {
    at += ms;
    for (const [fire, due] of [...timers]) if (due <= at) { timers.delete(fire); fire(); }
  };
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }], tokensPerSecond: Infinity });
  const seen: string[] = [];
  faux.setResponses(Array.from({ length: 8 }, () => ({ messages }, options) => {
    if (options?.sessionId !== "proactive-memory") return say("助手发言不进入画像");
    expect(options.reasoning).toBe("low");
    seen.push(contentText(messages.at(-1)!.content));
    return say("[]");
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await openAlter(new MemoryStorage(), models, { provider: "faux", modelId: "faux-1" }, undefined, {}, {
    now: () => at, timeZone: "UTC", memoryConsolidationTurns: 200,
    setTimer(fire, delay) { timers.set(fire, at + delay); return () => timers.delete(fire); },
  });
  try {
    await app.main.commit(async tx => {
      for (let i = 0; i < 198; i++) await recordUserMessage(tx, { id: String(i), text: "短消息", at });
    }, context);
    await submitMessage(app.main, "用户本人", "web", "mine");
    await submitMessage(app.main, "用户本人", "web", "mine");
    await submitMessage(app.main, "系统消息排除", "schedule");
    await app.main.waitForIdle(context);
    for (const [ref, author, text] of [["other", "external", "他人排除"], ["unknown", undefined, "未标注排除"], ["own", "user", "本人群聊"]] as const) {
      await app.events.emit({ source: "feishu", kind: "message", at, ...(author && { author }), ref, text, summary: "unsubscribe", untrusted: true });
    }
    expect((await app.harness.snapshot(MemoryInbox, app.main.id, context))?.turns).toBe(199);
    advance(30 * 60_000);
    expect(seen).toEqual([]);
    await submitMessage(app.main, "第两百轮", "cli");
    await app.main.waitForIdle(context);
    advance(30 * 60_000 - 1);
    expect(seen).toEqual([]);
    advance(1);
    await expect.poll(() => app.memory.store.changes().map(c => c.kind)).toEqual(["consolidate"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("本人群聊");
    expect(seen[0]).toContain("第两百轮");
    expect(seen[0]).toContain("用户本人");
    expect(seen[0]).not.toMatch(/排除|助手发言|当前时间/);
    expect((await app.harness.snapshot(MemoryInbox, app.main.id, context))?.turns).toBe(0);
  } finally { await app.close(); }
});

it("recovers a committed batch without replaying it or consuming later turns", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "alter-memory-recover-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const open = async () => openAlter(await openNodeSqliteStorage(join(dir, "main.sqlite")), createModels(), { provider: "offline", modelId: "unused" });
  const app = await open();
  try {
    await app.main.commit(async tx => {
      for (const id of ["a", "b", "c"]) await recordUserMessage(tx, { id, at: 10, text: id });
    }, context);
    app.memory.store.apply([{ op: "add", entry: { title: "资料", type: "reference", body: "已记下" } }], "consolidate",
      JSON.stringify({ first: "a", last: "b", count: 2, turns: 2, through: 15 }));
  } finally { await app.close(); }
  const next = await open();
  try {
    expect((await next.harness.snapshot(MemoryInbox, next.main.id, context))).toMatchObject({ turns: 1, messages: [{ id: "c" }], through: 15 });
    expect(next.memory.store.changes()).toHaveLength(1);
  } finally { await next.close(); }
});
