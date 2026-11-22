import { expect, it } from "vitest";
import { cases } from "../evals/permissions/cases.ts";
import { classify, describe } from "../evals/permissions/report.ts";
import { runCases } from "../evals/permissions/runner.ts";

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
