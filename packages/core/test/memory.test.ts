import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createMemory } from "../src/memory.ts";

it("persists memories and keeps both substring search paths in sync with edits and deletes", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "alter-memory-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  let at = 100;
  const open = () => createMemory(dir, () => at);
  const memory = open();
  const close = await memory.start();
  try {
    const profile = memory.save({ kind: "profile", text: "回答要简短" });
    const goal = memory.save({ kind: "goal", text: "12 月中考试", due: 101 });
    const fact = memory.save({ kind: "fact", text: '考试占 5%（"abc"）' });
    expect(memory.search("考试").map(row => row.id)).toEqual([fact, goal]);
    expect(memory.search("考试", "goal").map(row => row.id)).toEqual([goal]);
    expect(memory.search("中考试").map(row => row.id)).toEqual([goal]);
    expect(memory.search("%").map(row => row.id)).toEqual([fact]);
    expect(memory.search("_")).toEqual([]);
    expect(memory.search('"abc"').map(row => row.id)).toEqual([fact]);

    at = 101;
    expect(memory.list().find(row => row.id === goal)?.status).toBe("active");
    at++;
    expect(memory.search("考试", "goal")).toEqual([{ id: goal, kind: "goal", text: "12 月中考试",
      due: 101, status: "pending", createdAt: 100, updatedAt: at }]);
    at++;
    expect(memory.update(goal, { text: "申请实习", due: null, status: "done" })).toBe(true);
    expect(memory.search("中考试")).toEqual([]);
    expect(memory.search("请实习")).toEqual([{ id: goal, kind: "goal", text: "申请实习",
      status: "done", createdAt: 100, updatedAt: at }]);
    expect(() => memory.update(profile, { due: 200 })).toThrow("Only goals");
    expect(memory.delete(fact)).toBe(true);
    expect(memory.delete(fact)).toBe(false);
    expect(memory.search('"abc"')).toEqual([]);
  } finally {
    await close();
  }
  const reopened = open();
  const stop = await reopened.start();
  try {
    expect(reopened.list().map(row => row.text)).toEqual(["申请实习", "回答要简短"]);
    expect(reopened.search("请实习")[0]?.status).toBe("done");
  } finally { await stop(); }
});

it("takes ISO deadlines in the user's time zone and revives a goal whose deadline moves forward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-memory-due-"));
  const at = Date.parse("2026-11-22T07:00:00Z");
  const memory = createMemory(dir, () => at, "Asia/Shanghai");
  const close = await memory.start();
  try {
    const call = (name: string, args: Record<string, unknown>) =>
      memory.tools.find(tool => tool.name === name)!.execute(args as never, {} as never, {} as never);
    await call("memory_write", { type: "goal", title: "操作系统期末", body: "准备操作系统期末考试。", dueAt: "2026-12-15" }); // op defaults to add.
    const goal = memory.list()[0]!;
    // A date means the whole local day: the deadline is midnight at the start of Dec 16 in Shanghai.
    expect(goal.due).toBe(Date.parse("2026-12-15T16:00:00Z"));
    expect(memory.summary()).toContain("期限 2026-12-16 00:00");
    memory.update(goal.id, { due: at - 1 });
    expect(memory.list()[0]!.status).toBe("pending");
    await call("memory_write", { op: "modify", id: goal.id, dueAt: "2026-12-15T09:00" });
    expect(memory.list()[0]).toMatchObject({ status: "active", due: Date.parse("2026-12-15T01:00:00Z") });
    await expect(call("memory_write", { op: "modify", id: goal.id, dueAt: "12/15" })).rejects.toThrow("ISO");
    await call("memory_write", { op: "modify", id: goal.id, status: "done" });
    expect(memory.store.read(goal.id)).toMatchObject({ status: "done", dueAt: Date.parse("2026-12-15T01:00:00Z") });
    await call("memory_write", { op: "modify", id: goal.id, status: "active", dueAt: null });
    expect(memory.store.read(goal.id)?.status).toBe("active");
    expect(memory.store.read(goal.id)?.dueAt).toBeUndefined();
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});


it("migrates legacy rows and FTS atomically, keeping history IDs, local dates, deadlines and Unicode titles", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "alter-memory-migrate-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(join(dir, "memory.sqlite"));
  db.exec(`CREATE TABLE memory(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT,text TEXT,due INTEGER,status TEXT,createdAt INTEGER,updatedAt INTEGER);
    CREATE VIRTUAL TABLE memory_fts USING fts5(text,content='memory',content_rowid='id',tokenize='trigram');
    CREATE TRIGGER memory_insert AFTER INSERT ON memory BEGIN INSERT INTO memory_fts(rowid,text) VALUES(new.id,new.text); END;`);
  const add = db.prepare("INSERT INTO memory VALUES(?,?,?,?,?,0,1)");
  add.run(4, "profile", "你好。下一句", null, "active");
  add.run(6, "fact", "🐦".repeat(35), null, "active");
  add.run(8, "goal", "期末考试。准备资料", 1000, "done");
  add.run(50, "fact", "removed", null, "active");
  db.exec("DELETE FROM memory WHERE id=50");
  db.close();
  const memory = createMemory(dir, () => 20, "America/New_York");
  const stop = await memory.start();
  const view = memory.store.view();
  expect(view.entries.map(e => [e.id, e.type, e.title])).toEqual([["8", "goal", "期末考试。"], ["6", "reference", "🐦".repeat(30)], ["4", "user", "你好。"]]);
  expect(view.entries[0]).toMatchObject({ dueAt: 1000, status: "done", createdAt: 0, updatedAt: 1, source: "整理于 1969-12-31" });
  expect(view.index.split("\n")).toEqual([
    "[目标] 期末考试。（#8，已完成，期限 1970-01-01T00:00:01.000Z）", `[参考] ${"🐦".repeat(30)}（#6）`, "[用户] 你好。（#4）",
  ]);
  expect(memory.store.search("末考试").map(e => e.id)).toEqual(["8"]);
  expect(memory.store.search("资料").map(e => e.id)).toEqual(["8"]);
  await stop();
  const close = await memory.start();
  try {
    expect(memory.store.view()).toEqual(view);
    expect(memory.save({ kind: "goal", text: "新目标" })).toBe("51");
  } finally { await close(); }
});

it("reads, edits and undoes legacy entries without exposing their retired flag or rewriting existing rows", async ({ onTestFinished }) => {
  const dir = await mkdtemp(join(tmpdir(), "alter-memory-legacy-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(join(dir, "memory.sqlite"));
  onTestFinished(() => db.close());
  db.exec(`CREATE TABLE entries(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL,
    source TEXT NOT NULL, guess INTEGER NOT NULL, dueAt INTEGER, status TEXT NOT NULL, createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL, supersededBy INTEGER);`);
  const memory = createMemory(dir, () => 2);
  const stop = await memory.start();
  onTestFinished(stop);
  db.exec("INSERT INTO entries VALUES(1,'作息','user','六点起床','m1',1,NULL,'active',0,1,NULL)");
  const after = { title: "作息", type: "user", body: "六点起床", source: "m1", status: "active", createdAt: 0, updatedAt: 1, id: "1", guess: true };
  const before = { ...after, body: "七点起床", updatedAt: 0 };
  db.prepare("INSERT INTO changes(at,kind,operations,snapshots) VALUES(1,'write',?,?)")
    .run(JSON.stringify([{ op: "modify", ids: ["1"] }]), JSON.stringify([{ id: "1", before, after }]));
  expect(memory.store.read("1")).not.toHaveProperty("guess");
  expect(memory.store.view().index).not.toContain("猜的");
  expect(JSON.stringify(memory.store.changes())).not.toContain('"guess"');
  expect(memory.save({ kind: "fact", text: "新资料" })).toBe("2");
  expect(memory.update("1", { body: "六点起床" })).toBe(true);
  expect(db.prepare("SELECT guess FROM entries WHERE id=1").get()?.guess).toBe(1);
  memory.store.undo(memory.store.changes()[0]!.id);
  expect(memory.store.undo("1")).toBe(true);
  expect(memory.store.read("1")?.body).toBe("七点起床");
});

it("undo restores an entire supersession, preserves intervening unrelated edits and rejects conflicting edits", async () => {
  const memory = createMemory(undefined, () => 10);
  const stop = await memory.start();
  try {
    const call = async (name: string, args: object) => {
      const result = await memory.tools.find(t => t.name === name)!.execute(args as never, {} as never, {} as never);
      if (!("output" in result) || result.output?.[0]?.type !== "text") throw new Error("Expected text result");
      return result.output[0].text;
    };
    const entry = { type: "preference", title: "回答方式", body: "回答时给出细节。" };
    const id = await call("memory_write", { op: "add", ...entry });
    const original = memory.store.read(id);
    const next = await call("memory_write", { op: "supersede", id, ...entry, body: "请简洁。" });
    const change = memory.store.changes()[0]!;
    expect(JSON.parse(await call("memory_read", { ids: [id, next] }))).toMatchObject([{ supersededBy: next }, { id: next }]);
    expect(memory.store.search("回答方式").map(e => e.id)).toEqual([next]);
    expect(memory.store.search("给出细节")).toEqual([]);
    await call("memory_write", { op: "modify", id: next, title: "作答风格" });
    expect(() => memory.store.undo(change.id)).toThrow("newer changes");
    memory.store.undo(memory.store.changes()[0]!.id);
    memory.save({ kind: "fact", text: "无关条目" });
    expect(memory.store.undo(change.id)).toBe(true);
    expect(memory.store.read(id)).toEqual(original);
    expect(memory.store.read(next)).toBeUndefined();
    expect(memory.store.search("给出细节")[0]?.id).toBe(id);
    expect(memory.store.search("无关")).toHaveLength(1);
    const revision = memory.store.revision();
    expect(() => memory.store.apply([{ op: "delete", id }, { op: "modify", id: next, patch: { title: "错" } }])).toThrow();
    expect(memory.store.revision()).toBe(revision);
    expect(memory.store.read(id)).toEqual(original);
  } finally { await stop(); }
});
