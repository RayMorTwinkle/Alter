import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, ModelInputModality, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { hasApi } from "@earendil-works/pi-ai/models";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { arr, bool, compile, int, map, nullable, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";

const count = int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const effort = opt(nullable(str({ minLength: 1 })));
const overrides = obj({
  contextWindow: opt(count), maxTokens: opt(count), reasoning: opt(bool()),
  input: opt(arr(oneOf(["text", "image"]), { minItems: 1, uniqueItems: true })),
  thinkingLevelMap: opt(obj({ off: effort, minimal: effort, low: effort, medium: effort, high: effort, xhigh: effort, max: effort })),
});
const validFile = compile(map(overrides));
export const validModelOverrides = compile(overrides);
type Overrides = Static<typeof overrides>;
const defaultInput: ModelInputModality[] = ["text", "image"];
const aliases = new Map([["codex", "openai-codex"]]);
const exact = new Map<string, Model<Api>>();
const byName = new Map<string, Model<Api>>();
function lookup(id: string) {
  if (!exact.size) {
    for (const provider of getBuiltinProviders()) for (const model of getBuiltinModels(provider)) {
      exact.set(provider + "/" + model.id, model);
      if (!byName.has(model.id)) byName.set(model.id, model);
    }
  }
  const slash = id.indexOf("/");
  const prefix = id.slice(0, slash);
  const name = id.slice(slash + 1);
  return exact.get((aliases.get(prefix) ?? prefix) + "/" + name) ?? byName.get(name);
}

export function resolveCapabilities(id: string, manual: Overrides = {}) {
  const catalog = lookup(id);
  const source = (key: keyof Overrides): "manual" | "catalog" | "default" =>
    manual[key] !== undefined ? "manual" : catalog?.[key] !== undefined ? "catalog" : "default";
  const thinkingLevelMap: ThinkingLevelMap | null = manual.thinkingLevelMap ?? catalog?.thinkingLevelMap ?? null;
  return {
    id, contextWindow: manual.contextWindow ?? catalog?.contextWindow ?? 65536,
    maxTokens: manual.maxTokens ?? catalog?.maxTokens ?? 4096,
    input: manual.input ?? catalog?.input ?? defaultInput,
    reasoning: manual.reasoning ?? catalog?.reasoning ?? true, thinkingLevelMap,
    sources: { contextWindow: source("contextWindow"), maxTokens: source("maxTokens"), input: source("input"),
      reasoning: source("reasoning"), thinkingLevelMap: source("thinkingLevelMap") },
  };
}

export function gatewayCompat(id: string): Model<"openai-completions">["compat"] {
  const catalog = lookup(id);
  // Provider-specific wire formats are meaningful only on an exact completions match.
  const compat = catalog && exact.get(id) === catalog && hasApi(catalog, "openai-completions") ? catalog.compat : undefined;
  return { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: compat?.supportsReasoningEffort ?? true,
    maxTokensField: "max_tokens", thinkingFormat: compat?.thinkingFormat,
    requiresReasoningContentOnAssistantMessages: compat?.requiresReasoningContentOnAssistantMessages };
}

export function openModelCapabilities(dir: string, ids: string[], rebuild: () => void) {
  const path = join(dir, "model-capabilities.json");
  let saved: Record<string, Overrides> = {};
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!validFile.check(data)) throw new Error("Invalid model-capabilities.json");
    saved = data;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const configured = new Set(ids);
  const get = (id: string) => resolveCapabilities(id, saved[id]);
  return {
    dataDir: dir, get, list: () => Array.from(configured, get),
    replace(id: string, values: Overrides) {
      if (!configured.has(id)) return;
      const next = { ...saved };
      if (Object.keys(values).length) next[id] = values;
      else delete next[id];
      const temp = path + "." + randomUUID();
      try {
        writeFileSync(temp, JSON.stringify(next), { flag: "wx", mode: 0o600 });
        renameSync(temp, path);
      } finally { rmSync(temp, { force: true }); }
      saved = next;
      rebuild();
      return get(id);
    },
  };
}
