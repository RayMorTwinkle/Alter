import { isIP } from "node:net";

export type Effect = "read" | "write-local" | "external-send" | "irreversible";
export type Schema = {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean;
  items?: Schema; enum?: (string | number | boolean | null)[];
};
export type Manifest = {
  schemaVersion: 1; id: string; version: string; displayName: string; description: string;
  tools: { name: string; description: string; effect: Effect; inputSchema: Schema; outputSchema?: Schema }[];
  sources: { name: string; minIntervalSeconds: number }[];
  requires?: string[];
  network?: { host: string; methods: string[]; pathPrefixes: string[] }[];
  secrets: { name: string; purpose: string }[]; borrows: string[];
  resources: { memoryMB: number; timeoutMs: number; storageKB: number };
};
export class PluginError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function check(value: unknown, message: string): asserts value {
  if (!value) throw new PluginError(message);
}
export const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export function fields(v: unknown, names: string): asserts v is Record<string, unknown> {
  const allowed = names ? names.split(" ") : [];
  check(record(v) && Object.keys(v).every(k => allowed.includes(k)), "Invalid object or unknown field");
}
function label(v: unknown): asserts v is string {
  check(typeof v === "string" && v.trim() && v.length <= 2048, "Expected nonempty text");
}
function identifier(v: unknown): asserts v is string {
  check(typeof v === "string" && /^[a-z][a-z0-9_]{0,47}$/.test(v) && !Object.hasOwn(Object.prototype, v), "Invalid identifier");
}
function bounded(v: unknown, min: number, max: number) {
  check(typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max, 'Expected integer in range ' + min + '–' + max);
}
function array(v: unknown, verify: (item: unknown) => void, key?: (item: unknown) => unknown) {
  check(Array.isArray(v) && v.length <= 128, "Invalid list");
  v.forEach(verify);
  if (key) check(new Set(v.map(key)).size === v.length, "Duplicate entry");
}
const self = (v: unknown) => v;
const nameOf = (v: unknown) => (v as { name: string }).name;
const effects: Effect[] = ["read", "write-local", "external-send", "irreversible"];
function schema(s: unknown, depth = 0) {
  check(depth <= 12 && record(s), "Invalid schema depth or type");
  const base = "type description enum";
  fields(s, base + (s.type === "object" ? " properties required additionalProperties" : s.type === "array" ? " items" : ""));
  check(["object", "array", "string", "number", "integer", "boolean", "null"].includes(typeof s.type === "string" ? s.type : ""), "Invalid schema type");
  if ("description" in s) label(s.description);
  if ("enum" in s) {
    check(Array.isArray(s.enum) && s.enum.length > 0, "Empty schema enum");
    array(s.enum, v => check(v === null || ["number", "string", "boolean"].includes(typeof v), "Invalid enum"), self);
  }
  if ("properties" in s) {
    check(record(s.properties) && Object.keys(s.properties).length <= 128, "Invalid properties");
    for (const [k, v] of Object.entries(s.properties)) {
      check(!Object.hasOwn(Object.prototype, k) && k !== "prototype", "Invalid property name");
      schema(v, depth + 1);
    }
  }
  if ("required" in s) array(s.required, label, self);
  if ("additionalProperties" in s) check(typeof s.additionalProperties === "boolean", "Invalid additionalProperties");
  if ("items" in s) schema(s.items, depth + 1);
}

export function matches(s: Schema, value: unknown): boolean {
  if (s.enum && !s.enum.some(v => v === value)) return false;
  if (s.type === "object") return record(value) && (s.required ?? []).every(k => Object.hasOwn(value, k)) &&
    Object.entries(value).every(([k, v]) => s.properties && Object.hasOwn(s.properties, k) ? matches(s.properties[k]!, v) : s.additionalProperties !== false);
  if (s.type === "array") return Array.isArray(value) && (!s.items || value.every(v => matches(s.items!, v)));
  if (s.type === "integer") return Number.isSafeInteger(value);
  if (s.type === "number") return Number.isFinite(value);
  return s.type === "null" ? value === null : typeof value === s.type;
}

export function parseManifest(v: unknown): Manifest {
  fields(v, "schemaVersion id version displayName description tools sources network requires secrets borrows resources");
  check(v.schemaVersion === 1, "Unsupported schemaVersion");
  check(typeof v.id === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(v.id) && !Object.hasOwn(Object.prototype, v.id), "Invalid plugin id");
  label(v.version); label(v.displayName); label(v.description);
  array(v.tools, t => {
    fields(t, "name description effect inputSchema outputSchema");
    identifier(t.name); label(t.description); check(effects.includes(t.effect as Effect), "Unsupported effect");
    schema(t.inputSchema); check(record(t.inputSchema) && t.inputSchema.type === "object", "Expected object input schema");
    if ("outputSchema" in t) schema(t.outputSchema);
  }, nameOf);
  array(v.sources, s => { fields(s, "name minIntervalSeconds"); identifier(s.name); bounded(s.minIntervalSeconds, 1, 2_147_483); }, nameOf);
  if ("requires" in v) array(v.requires, label, self);
  if ("network" in v) array(v.network, r => {
    fields(r, "host methods pathPrefixes");
    check(typeof r.host === "string" && r.host.length <= 253 && (r.host.split(".").every(l => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) || r.host.startsWith("[") && r.host.endsWith("]") && isIP(r.host.slice(1, -1)) === 6), "Invalid exact host");
    array(r.methods, m => check(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(typeof m === "string" ? m : ""), "Invalid method"), self);
    array(r.pathPrefixes, p => check(typeof p === "string" && /^\/[\w./~-]*$/.test(p) && !p.split("/").some(k => k === "." || k === ".."), "Invalid path prefix"), self);
    check((r.methods as unknown[]).length && (r.pathPrefixes as unknown[]).length, "Empty network rule");
  });
  array(v.secrets, s => { fields(s, "name purpose"); identifier(s.name); label(s.purpose); }, nameOf);
  array(v.borrows, n => check(typeof n === "string" && /^[a-z][a-z0-9_-]{0,95}$/.test(n), "Invalid borrowed tool"), self);
  fields(v.resources, "memoryMB timeoutMs storageKB");
  bounded(v.resources.memoryMB, 32, 1024); bounded(v.resources.timeoutMs, 1, 300_000); bounded(v.resources.storageKB, 0, 16384);
  const m = v as Manifest;
  check(m.sources.length || m.tools.length, "Expected at least one tool or source");
  return m;
}

const effectLabels = { read: "读取数据", "write-local": "修改本地数据", "external-send": "对外发送", irreversible: "执行不可逆操作" };
function toolPermission(t: Manifest["tools"][number]) {
  return "工具 " + t.name + " 可" + effectLabels[t.effect] + " (" + t.effect + ")";
}
export function permissions(m: Manifest) {
  return [
    ...m.tools.map(toolPermission),
    ...m.sources.map(s => "订阅 " + s.name),
    ...(m.requires ?? []).map(item => "外部程序或设备 " + item),
    ...(m.network ?? []).flatMap(r => r.methods.flatMap(method => r.pathPrefixes.map(p => method + " https://" + r.host + p))),
    ...m.secrets.map(s => "密钥 " + s.name),
    ...m.borrows.map(b => "借用 " + b),
  ];
}
export function expanded(old: Manifest | undefined, next: Manifest) {
  const previous = new Set(old ? permissions(old) : []);
  for (const tool of next.tools) {
    const before = old?.tools.find(t => t.name === tool.name);
    if (before && effects.indexOf(tool.effect) < effects.indexOf(before.effect) && tool.effect !== "external-send") {
      previous.add(toolPermission(tool));
    }
  }
  return permissions(next).filter(p => !previous.has(p));
}
