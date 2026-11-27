import { expect, it } from "vitest";
import type { TaskRecord } from "../src/state.ts";
import { settleTask } from "../src/task-lifecycle.ts";

it.each(["queued", "running"] as const)("preserves the first terminal outcome when a %s worker resumes", status => {
  const task: TaskRecord = { status, brief: "work", permission: "restricted", context: "fresh", thinking: "low",
    worker: 2 as TaskRecord["worker"], conversationId: 1 as TaskRecord["conversationId"], createdAt: 25 };
  expect(settleTask(task, "interrupted", 20, "disconnected")).toBe(true);
  expect(settleTask(task, "completed", 40)).toBe(false);
  expect(task).toMatchObject({ status: "interrupted", endedAt: 25, failure: "disconnected" });
});
