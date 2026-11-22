import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    await call("memory_save", { kind: "goal", text: "操作系统期末", due: "2026-12-15" });
    const goal = memory.list()[0]!;
    // A date means the whole local day: the deadline is midnight at the start of Dec 16 in Shanghai.
    expect(goal.due).toBe(Date.parse("2026-12-15T16:00:00Z"));
    expect(memory.summary()).toContain("期限 2026-12-16 00:00");
    memory.update(goal.id, { due: at - 1 });
    expect(memory.list()[0]!.status).toBe("pending");
    await call("memory_update", { id: goal.id, due: "2026-12-15T09:00" });
    expect(memory.list()[0]).toMatchObject({ status: "active", due: Date.parse("2026-12-15T01:00:00Z") });
    await expect(call("memory_update", { id: goal.id, due: "12/15" })).rejects.toThrow("ISO");
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

