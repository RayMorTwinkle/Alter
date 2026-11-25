import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, expect, it, vi } from "vitest";
import { Audit, Reviews } from "../src/broker.ts";
import { day, Feedback, issueQuestions, putQuestion, type Effect } from "../src/feedback.ts";
import { interacted } from "../src/feedback-settings.ts";
import { createGatewayModels } from "../src/models.ts";
import { gatewayConfig } from "../src/config.ts";
import { readUsage } from "../src/usage.ts";
import { fakeGateway, say } from "./fixtures/gateway.ts";
import { Wakes } from "../src/wake.ts";
import { beginInspection, Heartbeat, recordAdoption } from "../src/heartbeat-state.ts";
import { recordRun } from "../src/heartbeat-runs.ts";
import { submitMessage } from "../src/timeline.ts";
import { openAlter } from "../src/main.ts";
import { addNotification } from "../src/notifications.ts";
import { context, MemoryStorage, openNodeSqliteStorage, type Tx } from "../src/runtime.ts";

// Exercise the retained feedback loop, including historical answer/undo behavior, with issuance enabled.
vi.mock(import("../src/feedback-settings.ts"), async original => ({ ...await original(), feedbackPaused: false }));

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { while (clean.length) await clean.pop()!(); });
const start = Date.parse("2026-12-01T12:00Z");
async function setup() {
  const clock = { at: start };
  const app = await openAlter(new MemoryStorage(), createModels(), { provider: "offline", modelId: "unused" }, undefined, {},
    { now: () => clock.at, timeZone: "UTC" });
  clean.push(app.close);
  const commit = <T>(f: (tx: Tx) => Promise<T>) => app.main.commit(f, context);
  const touch = () => commit(tx => interacted(tx, clock.at));
  const pick = (outlet: "report" | "checkin", limit: number) => commit(tx => issueQuestions(tx, { outlet, limit }, clock.at));
  return { app, clock, commit, touch, pick };
}
it("rejects missing or unusable effects and reduces the rank of frequently skipped questions", async () => {
  const { app, commit, touch, pick, clock } = await setup();
  const question = { id: "a", source: "style" as const, prompt: "方式？", options: ["短", "中", "长"], allowOther: false,
    why: "更新偏好", multi: false, effect: { kind: "metric", name: "style" } as Effect };
  await commit(async tx => {
    const bank = await tx.doc(Feedback, app.main.id);
    expect(() => putQuestion(bank, { ...question, effect: undefined as unknown as Effect }, clock.at)).toThrow();
    expect(() => putQuestion(bank, { ...question, effect: { kind: "param", key: "replyLength", mapping: {} } }, clock.at)).toThrow();
    bank.candidates = {};
    putQuestion(bank, question, clock.at, 3);
    putQuestion(bank, { ...question, id: "b", multi: true, prompt: "多选？" }, clock.at, 1.5);
  });
  await touch();
  const first = (await pick("report", 1))[0]!;
  expect(first.prompt).toBe("方式？");
  await app.feedback.skip(first.id);
  clock.at += 7 * day;
  await touch();
  expect((await pick("report", 2)).map(q => q.prompt)).toEqual(["多选？"]);
  expect(await pick("checkin", 5)).toEqual([]);
  clock.at += 7 * day;
  await touch();
  expect((await pick("report", 2)).map(q => q.prompt)).toEqual(["多选？", "方式？"]);
  await expect(app.feedback.answer(first.id, { options: ["短"] })).rejects.toMatchObject({ status: 409 });
});
it("applies scoped rule-derived parameters, report frequency and preference memory, and records metric denominators", async () => {
  const { app, commit, clock } = await setup();
  await commit(async tx => {
    (await tx.doc(Reviews, app.main.id)).byId.r = { tool: "mail_send", judgment: { inScope: true, reason: "ok" }, user: "deny" };
    for (const id of ["a", "b"]) await addNotification(tx, { id, source: "mail", kind: "event", title: id, level: "now",
      status: "read", feedback: "useless", at: clock.at }, start);
  });
  await app.feedback.feature("ext-weekly", "每周速览");
  await app.feedback.featureResult("ext-weekly", clock.at);
  const all = [...await app.feedback.more(), ...await app.feedback.more(), ...await app.feedback.more()];
  const answers = [
    ["权限说明", "核对用途"], ["分诊级别", "静默"], ["回复长度", "简短"], ["近况报告", "少一些"], ["满意度", "满意"],
  ];
  for (const [why, value] of answers) {
    const q = all.find(q => q.why.includes(why!))!;
    await app.feedback.answer(q.id, { options: [value] });
  }
  await app.feedback.skip(all.find(q => q.multi)!.id);
  expect(await app.feedback.settings()).toMatchObject({ replyLength: "简短", reportFrequency: 2, triagePreference: { mail: "silent" },
    permissionNotes: { mail_send: "核对用途" } });
  expect(app.memory.summary()).toContain("简短");
  const stats = await app.feedback.stats();
  expect(stats).toMatchObject({ asked: 7, answered: 5, skipped: 1, answerRate: 5 / 7, skipRate: 1 / 7,
    bySource: { mismatch: { answered: 2, answerRate: 1 } }, byType: { multi: { skipped: 1, skipRate: 1 } },
    satisfaction: [{ at: start, value: 3 }], changeCount: 5, weekly: [{ week: "2026-11-30", satisfaction: 3 }] });
  for (const c of (await app.feedback.view()).changes) await app.feedback.undo(c.id);
  expect(await app.feedback.settings()).toMatchObject({ replyLength: null, reportFrequency: 1, triagePreference: {}, permissionNotes: {} });
  expect(app.memory.summary()).not.toContain("简短");
  expect((await app.feedback.stats()).satisfaction).toEqual([]);
});
it("sends due checkins only after recent activity and doubles the interval after two fully skipped visits", async () => {
  const { app, commit, clock, touch, pick } = await setup();
  const tick = () => commit(tx => app.feedback.checkin(tx, clock.at));
  clock.at += 7 * day;
  await tick();
  expect((await app.feedback.view()).pending).toEqual([]);
  await touch();
  await tick();
  let pending = (await app.feedback.view()).pending;
  expect(pending).toHaveLength(3);
  for (const q of pending) await app.feedback.skip(q.id);
  clock.at += 7 * day;
  await commit(async tx => {
    const bank = await tx.doc(Feedback, app.main.id);
    for (let i = 0; i < 5; i++) putQuestion(bank, { ...bank.candidates["style:report"]!, id: "new:" + i }, clock.at);
  });
  expect(await pick("report", 2)).toEqual([]);
  await touch();
  await tick();
  pending = (await app.feedback.view()).pending;
  expect(pending).toHaveLength(5);
  for (const q of pending) await app.feedback.skip(q.id);
  clock.at += 7 * day;
  await touch();
  expect((await tick())?.nextAt).toBe(clock.at + 7 * day);
  expect((await app.feedback.view()).pending).toEqual([]);
  clock.at += 7 * day;
  await touch(); await tick();
  expect((await app.feedback.view()).pending).toHaveLength(5);
});
it("uses only unanswered proactive output, applies the heartbeat bias and compares measured adoption before and after", async () => {
  const { app, commit, clock } = await setup();
  async function run(id: string, at: number, notified: boolean, responded: boolean) {
    await commit(async tx => {
      await beginInspection(tx, await tx.doc(Heartbeat, app.main.id), at, id);
      await recordRun(tx, { id, at, finishedAt: at, notified, actions: [], status: "ran", tokens: 0, skipReason: null,
        finalReply: "", feedback: null, counts: { goals: 0, memories: 0, chat: 0, agenda: 0, tasks: 0, digests: 0 } });
      if (responded) await recordAdoption(tx, id);
    });
  }
  await run("quiet", start - 3 * day, false, false);
  await run("accepted", start - 2 * day, true, true);
  expect((await app.feedback.more()).some(q => q.why.includes("巡检"))).toBe(false);
  await run("silent", start - day, true, false);
  const q = (await app.feedback.more()).find(q => q.why.includes("巡检"))!;
  await app.feedback.answer(q.id, { options: ["少一些"] });
  expect((await app.feedback.settings()).heartbeatBias).toBe(2);
  clock.at += day;
  await run("later", clock.at, true, true);
  expect((await app.feedback.stats()).impacts).toMatchObject([{ metric: "heartbeatAdoption", before: 1 / 3, beforeSamples: 3, after: 1, afterSamples: 1 }]);
  await app.feedback.undo(q.id);
  expect((await app.feedback.settings()).heartbeatBias).toBe(1);
});
it("defers an active main turn and withholds a weekly batch with fewer than three eligible questions", async () => {
  const { app, commit, clock, touch, pick } = await setup();
  await touch();
  await pick("checkin", 4);
  clock.at += 7 * day;
  await submitMessage(app.main, "现在在聊");
  await commit(tx => app.feedback.checkin(tx, clock.at));
  expect((await app.harness.snapshot(Feedback, app.main.id, context))?.visits).toEqual([]);
  const second = await setup();
  second.clock.at += 7 * day;
  await second.touch();
  await second.pick("checkin", 4);
  await second.commit(tx => second.app.feedback.checkin(tx, second.clock.at));
  expect((await second.app.feedback.view()).pending).toHaveLength(3);
});
it("recovers a committed memory write after restart and reconciles undo from the memory API", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-feedback-"));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  async function open() {
    const app = await openAlter(await openNodeSqliteStorage(join(dir, "main.sqlite")), createModels(),
      { provider: "offline", modelId: "unused" }, undefined, {}, { now: () => start });
    clean.push(app.close);
    return app;
  }
  const first = await open();
  const q = (await first.feedback.more()).find(q => q.why.includes("回复长度"))!;
  const apply = first.memory.store.apply;
  vi.spyOn(first.memory.store, "apply").mockImplementationOnce((...args) => { apply(...args); throw new Error("interrupted after SQLite commit"); });
  await expect(first.feedback.answer(q.id, { options: ["详细"] })).rejects.toThrow("interrupted");
  expect((await first.feedback.view()).history[0]?.status).toBe("applying");
  await first.close();
  const app = await open();
  expect(app.memory.store.view().entries).toHaveLength(1);
  expect(await app.feedback.settings()).toMatchObject({ replyLength: "详细" });
  const c = (await app.feedback.view()).changes[0]!;
  expect(c).toMatchObject({ issueId: q.id, before: null, after: "详细" });
  const sql = new DatabaseSync(join(dir, "feedback.sqlite"), { readOnly: true });
  try {
    expect(sql.prepare("SELECT asked,answered FROM feedback_questions WHERE id='style:length'").get()).toMatchObject({ asked: 1, answered: 1 });
    expect(sql.prepare("SELECT key,after FROM feedback_param_changes WHERE id=?").get(c.id)).toMatchObject({ key: "replyLength", after: "详细" });
  } finally { sql.close(); }
  expect(app.memory.store.undo(c.memoryChangeId!)).toBe(true);
  await expect.poll(async () => (await app.feedback.settings()).replyLength).toBe(null);
  expect((await app.feedback.view()).changes).toHaveLength(2);
});

it("requires both a real release and recent use, shows the display name, and caps feature and fixed metric questions per batch", async () => {
  const { app, clock, commit } = await setup();
  const at = clock.at;
  await app.replacePlugin("calendar", { capability: { id: "calendar", mainLeasable: true, actions: [] }, tools: [] });
  const installs = [
    ["ext-unused", "未用功能", at], ["ext-old", "旧功能", at - 31 * day], ["ext-stale", "陈旧调用", at - 20 * day],
    ["ext-few", "只用两次", at - day], ["ext-three", "活动发现", at - 20 * day], ["ext-output", "招聘摘要", at - day],
  ] as const;
  for (const [id, name, since] of installs) await app.feedback.feature(id, name, since);
  await app.feedback.featureResult("ext-output", at - 100);
  await app.feedback.featureResult("ext-old", at);
  await commit(async tx => {
    const audit = await tx.doc(Audit, app.main.id);
    for (const [capability, count, age] of [["ext-three", 3, 14], ["ext-stale", 3, 15], ["ext-few", 2, 0], ["calendar", 6, 0]] as const) {
      for (let i = 0; i < count; i++) audit.entries.push({ capability, tool: "read", action: "read", decision: "allow",
        taskId: "main", effect: "read", at: at - age * day });
    }
  });
  await app.feedback.more();
  await app.feedback.more();
  const pending = app.feedback.view().pending;
  const features = pending.filter(q => q.source === "feature");
  expect(features.map(q => q.prompt).sort()).toEqual(["用过「招聘摘要」后，你觉得哪里有帮助？", "用过「活动发现」后，你觉得哪里有帮助？"].sort());
  expect(new Set(features.map(q => q.batch)).size).toBe(2);
  const metrics = pending.filter(q => q.candidateId === "style:usefulness" || q.candidateId === "style:satisfaction");
  expect(metrics).toHaveLength(2);
  expect(new Set(metrics.map(q => q.batch)).size).toBe(2);
});

it.each([true, false])("reviews a batch once and validates option mappings (valid=%s)", async valid => {
  const dir = await mkdtemp(join(tmpdir(), "alter-feedback-quality-"));
  clean.push(() => rm(dir, { force: true, recursive: true }));
  const gateway = await fakeGateway((req, res) => {
    const payload = JSON.parse(req.messages.at(-1)!.content);
    return say(res, JSON.stringify(payload.candidates.map((q: { id: string; options: string[] }) => {
      if (q.id === "style:report") return { id: q.id, decision: "keep", prompt: "你想多久听一次近况？",
        options: ["少打扰我", "照旧", "多聊聊"], mapping: { 少打扰我: "少一些", 照旧: "默认频率", 多聊聊: valid ? "频繁一些" : "少一些" } };
      if (q.id === "style:satisfaction") return { id: q.id, decision: "keep", prompt: "最近的帮助你满意吗？",
        options: ["很满意", "还行", "不太好"], mapping: { 很满意: "满意", 还行: "一般", 不太好: "不满意" } };
      return { id: q.id, decision: "drop" };
    })));
  });
  clean.push(gateway.close);
  const { models, mainModel, taskModel } = await createGatewayModels(gatewayConfig({ ALTER_LLM_BASE_URL: gateway.baseUrl,
    ALTER_LLM_API_KEY: "offline-key", ALTER_MAIN_MODEL: "offline/main", ALTER_TASK_MODEL: "offline/task", ALTER_DATA_DIR: dir }));
  const app = await openAlter(new MemoryStorage(), models, mainModel, taskModel, {}, { now: () => start, dataDir: dir });
  clean.push(app.close);
  app.memory.store.apply([
    { op: "add", entry: { title: "回复风格", body: "回复风格要简短", type: "preference" } },
  ]);
  await app.main.commit(async tx => {
    const { byId } = await tx.doc(Wakes, app.main.id);
    for (const [key, at] of [["old", start - 8 * day], ["recent", start]] as const) byId[key] = { wakeId: key, wakeSource: "user-web", wakeAt: at };
  }, context);
  const questions = await app.feedback.more();
  expect(gateway.requests).toHaveLength(1);
  expect(gateway.requests[0]?.reasoning_effort).toBe("low");
  const input = JSON.parse(gateway.requests[0]!.messages.at(-1)!.content);
  expect(input.memoryIndex).toContain("回复风格要简短");
  expect(input.usage).toMatchObject({ days: 7, userTurns: 1 });
  expect(input.candidates.find((q: { id: string }) => q.id === "style:length")).toBeUndefined();
  expect(questions).toHaveLength(2);
  const report = questions.find(q => q.why.includes("近况报告"))!;
  if (!valid) {
    expect(report.prompt).toBe("你希望多久收到一次近况报告？");
    expect(report.options).toEqual(["频繁一些", "默认频率", "少一些"]);
    await app.feedback.answer(report.id, { options: ["少一些"] });
  } else await app.feedback.answer(report.id, { options: ["少打扰我"] });
  await app.feedback.answer(questions.find(q => q.options.includes("很满意"))!.id, { options: ["很满意"] });
  expect((await app.feedback.settings()).reportFrequency).toBe(2);
  expect((await app.feedback.stats()).satisfaction).toEqual([{ at: start, value: 3 }]);
  expect((await readUsage(dir)).map(r => [r.role, r.thinking, r.model])).toEqual([["feedback", "low", "offline/task"]]);
});

it("expires a pending preference when memory supplies the answer", async () => {
  const { app } = await setup();
  const length = (await app.feedback.more()).find(q => q.why.includes("回复长度"))!;
  app.memory.store.apply([{ op: "add", entry: { title: "沟通习惯", body: "回复风格要简短", type: "preference" } }]);
  await expect.poll(() => app.feedback.view().history.find(i => i.id === length.id)?.status).toBe("expired");
  expect((await app.feedback.more()).some(q => q.why.includes("回复长度"))).toBe(false);
});

it("retires legacy ID-only feature questions and excess pending metrics on startup without losing history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-feedback-upgrade-"));
  clean.push(() => rm(dir, { force: true, recursive: true }));
  const model = { provider: "offline", modelId: "unused" };
  const open = async () => openAlter(await openNodeSqliteStorage(join(dir, "main.sqlite")), createModels(), model, undefined, {}, { now: () => start });
  const app = await open();
  clean.push(app.close);
  await app.feedback.more();
  await app.main.commit(async tx => {
    const bank = await tx.doc(Feedback, app.main.id);
    const first = Object.values(bank.issues).find(i => i.candidateId === "style:satisfaction")!;
    const second = bank.candidates["style:usefulness"]!;
    const legacy = { ...first, id: "legacyGuess", source: "guess", candidateId: "guess:1", effect: { kind: "memory", entryId: "1" } };
    Object.assign(bank.issues, { legacyGuess: legacy });
    Object.assign(bank.candidates, { "guess:1": { ...second, ...legacy, id: "guess:1" } });
    bank.issues.legacyMetric = { ...first, id: "legacyMetric", candidateId: second.id, effect: second.effect, prompt: second.prompt, options: second.options };
    bank.issues.legacyFeature = { ...first, id: "legacyFeature", source: "feature", candidateId: "feature:calendar",
      effect: { kind: "metric", name: "feature:calendar" }, prompt: "calendar有哪些地方帮到了你？" };
  }, context);
  await app.close();
  const reopened = await open();
  clean.push(reopened.close);
  const { pending, history } = reopened.feedback.view();
  expect(pending.filter(i => i.candidateId === "style:satisfaction")).toHaveLength(1);
  expect(history.filter(i => i.status === "expired").map(i => i.id).sort()).toEqual(["legacyFeature", "legacyGuess", "legacyMetric"]);
  await expect(reopened.feedback.answer("legacyGuess", { options: [], other: "更正" })).rejects.toMatchObject({ status: 409 });
  await reopened.feedback.more();
  expect(reopened.feedback.view().pending.some(q => q.candidateId === "guess:1")).toBe(false);
  const stats = await reopened.feedback.stats();
  expect(stats).not.toHaveProperty("guesses");
  expect(stats.bySource).not.toHaveProperty("guess");
});
