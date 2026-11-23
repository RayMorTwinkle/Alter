import { expect, it, vi } from "vitest";
import { createCapabilityRegistry, defineTool, reply, schema, type AlterPlugin, type ToolRegistration } from "../src/index.ts";
import { normalUrl, recordUntrusted } from "../src/taint.ts";
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
      id: "guarded", note: "", caller: { kind: "task", permission, context: "fresh" },
      taint: tainted ? "task-read" : "clean", tool: "memory_write", args: { op: "add", type: "reference", title: "资料库", body: "课程资料放在学校网盘。" },
      effect: "write-local", expected: tainted ? "user" : "allow",
    });
    expect(result.actual).toBe(result.expected);
    if (tainted) expect(result).toMatchObject({ evidence: expect.stringContaining("fixture_untrusted") });
  }
});

it("allows a clean restricted task to use memory", async () => {
  const result = await runCase({
    id: "unlisted-memory", note: "", caller: { kind: "task", permission: "restricted", context: "fresh" },
    taint: "clean", tool: "memory_write", args: { op: "add", type: "preference", title: "回复语言", body: "请用中文回答。" }, effect: "write-local", expected: "allow",
  });
  expect(result.actual).toBe("allow");
});

const links: AlterPlugin = {
  capability: { id: "links", mainLeasable: true, actions: [
    { name: "open", effect: "read", guarded: true, seenArg: "url" },
    { name: "send", effect: "external-send", guarded: true, seenArg: "url" },
  ] },
  tools: ["open", "send"].map(name => defineTool({ name: "links_" + name, description: name,
    parameters: schema.obj({ url: schema.str() }), execute: async () => reply("OK") })),
};

it.each([
  ["open", "task-read", "full", "fresh", "allow"],
  ["send", "task-read", "full", "fresh", "user"],
  ["open", "main-read", "full", "fresh", "user"],
  ["open", "main-read", "full", "fork", "user"],
  ["open", "task-read", "restricted", "fresh", "allow"],
] as const)("checks seen URLs for %s after %s in a %s %s task (%s)", async (action, taint, permission, context, expected) => {
  const result = await runCase({ id: "seen", note: "", caller: { kind: "task", permission, context },
    taint, tool: "links_" + action, args: { url: "https://example.test/?a=1&b=2" },
    effect: action === "open" ? "read" : "external-send", expected }, [links]);
  expect(result.actual).toBe(expected);
});

it("keeps the 500 most recently seen distinct URLs across untrusted results", () => {
  const state = { seen: Array.from({ length: 500 }, (_, i) => `https://example.test/${i}`) };
  recordUntrusted(state, { source: "read", capability: "fixture", at: 1 }, reply(
    "&quot;https://example.test/0&quot; &lt;https://example.test/500&gt; &#39;https://example.test/501&#39; https://example.test/501。",
  ).output);
  expect(state.seen).toHaveLength(500);
  expect(state.seen[0]).toBe("https://example.test/3");
  expect(state.seen.slice(-3)).toEqual(["https://example.test/0", "https://example.test/500", "https://example.test/501"]);
});

it("drops surrounding punctuation while preserving the literal page URL and balanced delimiters", () => {
  const state = { seen: [] as string[] };
  recordUntrusted(state, { source: "browser_open", capability: "browser", at: 1 }, reply(
    '<external url="https://example.test/who?">[doc](https://example.test/doc_(old)). See http://[::1]!</external>',
  ).output);
  expect(state.seen).toEqual(["https://example.test/who?", "https://example.test/doc_(old)", "http://[::1]/"]);
});

it("normalizes seen URLs so a trailing slash is the same page", () => {
  const state: { seen?: string[] } = {};
  recordUntrusted(state, { source: "browser_open", capability: "browser", at: 0 },
    [{ type: "text", text: '<external source="browser" url="http://127.0.0.1:9/">page</external>' }]);
  expect(state.seen).toEqual(["http://127.0.0.1:9/"]);
  expect(state.seen).toContain(normalUrl("http://127.0.0.1:9"));
});

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
