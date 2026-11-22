import { expect, it } from "vitest";
import { cases } from "../evals/permissions/cases.ts";
import { classify, describe } from "../evals/permissions/report.ts";
import { runCase, runCases } from "../evals/permissions/runner.ts";

it("runs the annotated permission calls and fails on missed protections or runner errors", async () => {
  expect(cases.length).toBeGreaterThanOrEqual(60);
  expect(new Set(cases.map(c => c.id)).size).toBe(cases.length);
  const failures: string[] = [];
  for (const row of await runCases()) {
    const outcome = classify(row.expected, row.actual);
    if (outcome === "extra") console.warn("权限误报 · " + describe(row));
    if (outcome === "miss" || outcome === "error") failures.push(describe(row));
  }
  expect(failures).toEqual([]);
}, 30_000);

it.each(["restricted", "auto", "full"] as const)("requires user approval for a tainted guarded write under %s", async permission => {
  for (const tainted of [false, true]) {
    const result = await runCase({
      id: "guarded", note: "", caller: { kind: "task", permission, allow: ["memory", "fixture"], context: "fresh" },
      taint: tainted ? "task-read" : "clean", tool: "memory_save", args: { kind: "fact", text: "重要事实" },
      effect: "write-local", expected: tainted ? "user" : "allow",
    });
    expect(result.actual).toBe(result.expected);
    if (tainted) expect(result).toMatchObject({ evidence: expect.stringContaining("fixture_untrusted") });
  }
});

it("preserves main approval for a clean restricted task without a memory grant", async () => {
  const result = await runCase({
    id: "unlisted-memory", note: "", caller: { kind: "task", permission: "restricted", allow: [], context: "fresh" },
    taint: "clean", tool: "memory_save", args: { kind: "profile", text: "偏好" }, effect: "write-local", expected: "main",
  });
  expect(result.actual).toBe("main");
});
