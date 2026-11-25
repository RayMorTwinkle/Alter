import { HttpError } from "../static.ts";
import { record, strings, type AdapterDefinition, type AdapterPatch } from "./types.ts";

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HttpError(400, message);
}
export function fields(obj: Record<string, unknown>, allowed: string) {
  check(Object.keys(obj).every(k => allowed.split(" ").includes(k)), "Unknown adapter field");
}
export function definition(kind: unknown, config: unknown): AdapterDefinition {
  check(record(config), "Expected adapter config");
  if (kind === "mcp") check(config.readOnly === undefined || typeof config.readOnly === "boolean", "Expected readOnly flag");
  if (kind === "cli" || (kind === "mcp" && config.transport === "stdio")) {
    fields(config, kind === "cli" ? "command args env cwd help timeoutMs" : "transport command args env readOnly");
    check(typeof config.command === "string" && config.command.trim(), "Expected command");
    check(config.args === undefined || Array.isArray(config.args) && config.args.every(v => typeof v === "string"), "Expected string args");
    check(config.env === undefined || strings(config.env), "Expected string env values");
    check(config.help === undefined || typeof config.help === "string", "Expected help text");
    check(config.cwd === undefined || typeof config.cwd === "string", "Expected cwd");
    const ms = config.timeoutMs;
    check(ms === undefined || typeof ms === "number" && Number.isSafeInteger(ms) && ms > 0 && ms <= 600_000, "timeoutMs must be 1..600000");
  } else if (kind === "http" || (kind === "mcp" && config.transport === "http")) {
    fields(config, kind === "http" ? "spec baseUrl headers" : "transport url headers readOnly");
    if (kind === "http") {
      check(record(config.spec) || typeof config.spec === "string" && config.spec.trim(), "Expected OpenAPI document or URL");
      check(config.baseUrl === undefined || typeof config.baseUrl === "string", "Expected baseUrl");
    } else check(typeof config.url === "string" && config.url.trim(), "Expected MCP URL");
    check(config.headers === undefined || strings(config.headers), "Expected string headers");
  } else throw new HttpError(400, "Unknown adapter kind or transport");
  const credentialKey = /(?:authorization|cookie|password|secret|token|api[-_]?key)$/i;
  const placeholder = /\{\{(?:secret:[A-Za-z0-9_-]+|gh-token)\}\}/;
  function credential(value: string) {
    check(!value || placeholder.test(value), "Use a secret placeholder for credential settings");
  }
  for (const settings of [config.env, config.headers]) if (strings(settings)) {
    for (const [key, value] of Object.entries(settings)) if (credentialKey.test(key)) credential(value);
  }
  const server = record(config.spec) && Array.isArray(config.spec.servers) ? config.spec.servers[0] : undefined;
  for (const url of [config.url, config.baseUrl, config.spec, server?.url]) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
    const parsed = URL.parse(url);
    if (!parsed) continue; // The hostname or port may itself be a template.
    if (parsed.password) {
      let password: string;
      try { password = decodeURIComponent(parsed.password); }
      catch { throw new HttpError(400, "Invalid URL password encoding"); }
      credential(password);
    }
    for (const [key, value] of parsed.searchParams) if (credentialKey.test(key)) credential(value);
  }
  return { kind, config } as AdapterDefinition;
}
export function changes(input: Record<string, unknown>): AdapterPatch {
  fields(input, "name enabled config effects secrets");
  check(Object.keys(input).length, "Empty adapter patch");
  if ("name" in input) check(typeof input.name === "string" && input.name.trim(), "Expected display name");
  if ("enabled" in input) check(typeof input.enabled === "boolean", "Expected enabled flag");
  if ("effects" in input) check(record(input.effects) && Object.entries(input.effects).every(([k, v]) =>
    /^[a-z0-9_]+$/.test(k) && (v === "read" || v === "write" || v === "irreversible")), "Invalid adapter effects");
  if ("secrets" in input) check(strings(input.secrets) && Object.keys(input.secrets).every(k => /^[a-zA-Z0-9_-]+$/.test(k)), "Invalid adapter secrets");
  return input as AdapterPatch;
}
