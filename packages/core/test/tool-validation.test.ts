import { contentText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage as say, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import { expect, it, vi } from "vitest";
import { context, createRegistry, defineExtension, defineTool, Harness, hook, MemoryStorage, reply, ToolResultEntry, ToolTask } from "../src/runtime.ts";
import { toolArgumentError, withStrictToolArguments } from "../src/tool-validation.ts";

const query = { type: "object", required: ["q"], properties: { q: { type: "string" }, page_token: { type: "string" } } };

it("rejects raw non-objects, nulls, missing values and typos without modifying the schema", () => {
  expect(toolArgumentError(query, { q: "" })).toBeUndefined();
  for (const value of [null, [], "q", 42]) expect(toolArgumentError(query, value)).toMatch(/root.*expected object/);
  expect(toolArgumentError(query, new Date())).toContain("plain object");
  expect(toolArgumentError(query, { q: null })).toContain('"q": expected string, got null');
  expect(toolArgumentError(query, { q: "foo", page_token: null })).toMatch(/page_token.*null/);
  expect(toolArgumentError(query, { q: undefined })).toContain('missing required argument "q"');
  expect(toolArgumentError(query, { query: "foo" })).toBe(
    'missing required argument "q"; unknown argument "query" (allowed properties: "q", "page_token")');
  expect(toolArgumentError({ type: "object", required: ["q"], properties: { q: {} } }, { q: undefined })).toContain('missing required argument "q"');
  expect(toolArgumentError(query, { q: "foo", pageToken: "2", limit: 4 })).toBe(
    'unknown argument "pageToken" (allowed properties: "q", "page_token"); unknown argument "limit" (allowed properties: "q", "page_token")');
  expect(query).not.toHaveProperty("additionalProperties");
  expect(toolArgumentError({ properties: query.properties }, [])).toMatch(/root.*expected object/);
  expect(toolArgumentError({ type: "string" }, "not an object")).toBeUndefined();
});

it("reports strict types and constraints at their nested paths", () => {
  const schema = { type: "object", properties: { filters: { type: "array", items: { type: "object", required: ["count"], properties: {
    count: { type: "integer" }, text: { type: "string", minLength: 1 }, active: { type: "boolean" }, options: { type: "object" },
  } } } } };
  for (const [args, path] of [
    [{ count: 1.5 }, "count"], [{ count: "1" }, "count"], [{ count: true }, "count"], [{}, "count"],
    [{ count: 2, text: false }, "text"], [{ count: 2, text: [] }, "text"], [{ count: 2, text: {} }, "text"], [{ count: 2, text: "" }, "text"],
    [{ count: 2, active: "true" }, "active"], [{ count: 2, options: [] }, "options"], [{ count: 2, other: "x" }, "other"],
  ] as const) {
    expect(toolArgumentError(schema, { filters: [args] })).toContain('"filters[0].' + path + '"');
  }
  expect(toolArgumentError(schema, { filters: null })).toMatch(/filters.*null/);
  expect(toolArgumentError(schema, { filters: { count: 2 } })).toMatch(/filters.*expected array/);
  expect(toolArgumentError(schema, { filters: [{ count: 2, options: { arbitrary: true } }] })).toBeUndefined();
});

it("handles nullable types, local refs, and same-value schema composition", () => {
  const input = { type: "object", $defs: {
    payload: { properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] } } },
    leaf: { type: "object", properties: { next: { anyOf: [{ $ref: "#/$defs/leaf" }, { type: "null" }] } } },
  }, properties: {
    meta: { type: "object", allOf: [{ $ref: "#/$defs/payload" }, { properties: { b: { type: ["integer", "null"] } } }] },
    choice: { oneOf: [{ type: "integer" }, { const: null }] },
    other: { allOf: [{ anyOf: [{ type: "string" }, { type: "null" }] }, { type: "string" }] },
    leaf: { $ref: "#/$defs/leaf" },
  } };
  const good = { meta: { a: null, b: null }, choice: null, leaf: { next: { next: null } } };
  expect(toolArgumentError(input, good)).toBeUndefined();
  expect(toolArgumentError(input, { ...good, other: null })).toMatch(/other.*expected string.*null/);
  expect(toolArgumentError(input, { ...good, meta: { a: null, b: 1, c: 2 } })).toContain('unknown argument "meta.c" (allowed properties: "a", "b")');
  expect(toolArgumentError(input, { ...good, leaf: { next: { typo: true } } })).toContain('unknown argument "leaf.next.typo"');
  expect(toolArgumentError({ type: "object", properties: { q: { $ref: "#/$defs/missing" } } }, {})).toBeUndefined();
  expect(toolArgumentError({ type: "object", properties: { q: { $ref: "#/$defs/missing" } } }, { q: "x" })).toMatch(/q.*unresolved reference/);
});

it("respects open maps, typed additional properties and pattern properties", () => {
  const schema = { type: "object", properties: {
    open: { type: "object", properties: { name: { type: "string" } }, additionalProperties: true },
    typed: { type: "object", properties: {}, additionalProperties: { type: "integer" } },
    patterns: { type: "object", properties: { name: { type: "string" } }, patternProperties: { "^x-": { type: "boolean" } } },
    map: { type: "object" },
    union: { anyOf: [{ type: "object", properties: { name: { type: "string" } }, required: ["name"] }, { type: "object" }] },
  } };
  const good = { open: { extension: null }, typed: { version: 1 }, patterns: { "x-check": false }, map: { arbitrary: null }, union: { arbitrary: true } };
  expect(toolArgumentError(schema, good)).toBeUndefined();
  expect(toolArgumentError(schema, { ...good, open: { name: null } })).toMatch(/open.name.*null/);
  expect(toolArgumentError(schema, { ...good, typed: { version: null } })).toMatch(/typed.version.*null/);
  expect(toolArgumentError(schema, { ...good, patterns: { "x-check": "false" } })).toMatch(/patterns.x-check.*boolean/);
  expect(toolArgumentError(schema, { ...good, patterns: { xCheck: false } })).toMatch(/xCheck.*allowed properties.*name.*\^x-/);
});

it("composes a preparer and checks both the original and prepared arguments", () => {
  const prepareArguments = vi.fn((args: unknown) => ({ q: (args as { q: string }).q.trim() }));
  const original = defineTool({ name: "search", description: "Search", parameters: query, prepareArguments, execute: async () => reply("ok") });
  const strict = withStrictToolArguments(original, args => (args as { q: string }).q === "" ? '"q" must not be blank' : undefined);
  expect(strict.parameters).toBe(query);
  expect(withStrictToolArguments(strict)).toBe(strict);
  expect(strict.prepareArguments?.({ q: " test " })).toEqual({ q: "test" });
  expect(() => strict.prepareArguments?.({ q: null })).toThrow('"q": expected string, got null');
  expect(prepareArguments).toHaveBeenCalledTimes(1);
  expect(() => strict.prepareArguments?.({ q: " " })).toThrow('"q" must not be blank');
  prepareArguments.mockReturnValueOnce({ q: "test", typo: "x" } as { q: string });
  expect(() => strict.prepareArguments?.({ q: "test" })).toThrow('unknown argument "typo"');
});

it("settles invalid arguments without calling beforeTool or execute", async () => {
  const beforeTool = vi.fn(() => undefined);
  const execute = vi.fn(async () => reply("executed"));
  const tool = withStrictToolArguments(defineTool({ name: "send", description: "Send", parameters: obj({ text: str() }), execute }));
  const ext = defineExtension({ name: "strict", tools: [tool], hooks: [hook(ToolTask, { beforeTool })] });
  const registry = createRegistry();
  registry.install(ext);
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux" }], tokensPerSecond: Infinity });
  models.setProvider(faux.provider);
  faux.setResponses([say(fauxToolCall("send", { text: null }), { stopReason: "toolUse" }), say("done")]);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  try {
    const main = await harness.root(context, { agent: { extensions: [ext], model: { provider: "faux", modelId: "faux" } } });
    await (await main.submit({ type: "input", content: "send" }, context)).wait(context);
    const page = await main.entries({ order: "ascending" }, 100, undefined, context);
    const entry = page.items.find(ToolResultEntry.is)!;
    expect(entry.data.diagnostics).toMatchObject([{ code: "invalid_arguments" }]);
    expect(contentText(entry.model![0]!.content)).toContain('Invalid arguments for tool "send": "text": expected string, got null');
    expect(beforeTool).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  } finally { await harness.close(context); }
});
