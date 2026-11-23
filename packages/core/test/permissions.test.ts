import { expect, it, vi } from "vitest";
import { createCapabilityRegistry, defineTool, reply, schema, type AlterPlugin, type ToolRegistration } from "../src/index.ts";
import { cases } from "../evals/permissions/cases.ts";
import { classify, describe } from "../evals/permissions/report.ts";
import { runCases } from "../evals/permissions/runner.ts";

it("runs the annotated permission calls and fails on missed protections or runner errors", async () => {
  expect(new Set(cases.map(c => c.id)).size).toBe(cases.length);
  const failures: string[] = [];
  for (const row of await runCases()) {
    const outcome = classify(row.expected, row.actual);
    if (outcome !== "correct") failures.push(describe(row));
  }
  expect(failures).toEqual([]);
}, 30_000);

const links: AlterPlugin = {
  capability: { id: "links", mainLeasable: true, actions: [
    { name: "open", effect: "read" },
    { name: "send", effect: "write" },
  ] },
  tools: ["open", "send"].map(name => defineTool({ name: "links_" + name, description: name,
    parameters: schema.obj({ url: schema.str() }), execute: async () => reply("OK") })),
};

it("continues without context when a plugin metadata lookup stalls", async () => {
  vi.useFakeTimers();
  try {
    const registry = createCapabilityRegistry([{ ...links, describe: () => new Promise<never>(() => {}) }]);
    const lookup = registry.describe({ tool: "links_send", arguments: {} }, {
      conversationId: 1 as Parameters<ToolRegistration["execute"]>[1]["conversationId"], snapshot: async () => undefined,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await lookup).toBeUndefined();
  } finally { vi.useRealTimers(); }
});
