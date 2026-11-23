import type { PluginField } from "@alter/core";

export class SourceError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function keys(v: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new SourceError("Unknown source field");
}
function required(v: unknown, label: string) {
  if (typeof v !== "string" || !v.trim()) throw new SourceError("Expected " + label);
  return v.trim();
}
export function requestUrl(v: unknown, local = false) {
  let url: URL;
  try { url = new URL(required(v, "URL")); } catch { throw new SourceError("Invalid source URL"); }
  if (url.username || url.password || !(url.protocol === "https:" || (local && url.protocol === "http:" && url.hostname === "127.0.0.1"))) {
    throw new SourceError("Expected an HTTPS URL without credentials");
  }
  return url.href;
}

export type Spec = { template: "rss"; params: { url: string } } | { template: "github"; params: { token: string } } |
  { template: "json"; params: { url: string; itemsPath: string; idField: string; titleField: string; urlField: string;
    bodyField?: string; headers: Record<string, string>; secrets: Record<string, string> } };
export type Config = Spec & { name: string; enabled: boolean; intervalMinutes: number };
export type Item = { id: string; title: string; url: string; body?: string; publishedAt?: string; repo?: string; type?: string };
export type Template = { template: Spec["template"]; name: string; fields: PluginField[] };
function field(key: string, label: string, help: string, required = true, type: PluginField["type"] = "text"): PluginField {
  return { key, label, type, help, required };
}
const urlField = field("url", "地址", "HTTPS 接口地址");
export const templates: Template[] = [
  { template: "rss", name: "RSS / Atom", fields: [urlField] },
  { template: "json", name: "JSON 接口", fields: [urlField, field("itemsPath", "列表路径", "如 data.items，留空表示根数组", false),
    field("idField", "标识字段", "每条消息的唯一标识"), field("titleField", "标题字段", "消息标题"),
    field("urlField", "链接字段", "消息链接"), field("bodyField", "正文字段", "可选摘要", false),
    field("headers", "请求头", "键值对象，值可用 ${secret:api} 引用本实例密钥", false, "secret"),
    field("secrets", "请求头密钥", "名称到密钥的键值对象", false, "secret")] },
  { template: "github", name: "GitHub 通知", fields: [field("token", "GitHub token", "可读取通知的访问令牌", true, "secret")] },
];

function stringMap(v: unknown, names: RegExp) {
  if (v === undefined) return {};
  if (!record(v) || Object.keys(v).length > 32 || Object.entries(v).some(([k, value]) =>
    !names.test(k) || typeof value !== "string" || !value || /[\r\n\0]/.test(value))) throw new SourceError("Invalid header or secret");
  return { ...v } as Record<string, string>;
}
export function resolvedHeaders(params: Extract<Spec, { template: "json" }>["params"]) {
  return Object.fromEntries(Object.entries(params.headers).map(([k, v]) => [k, v.replace(/\$\{secret:([\w-]+)\}/g, (_, name: string) => {
    if (!Object.hasOwn(params.secrets, name)) throw new SourceError("Unknown source secret");
    return params.secrets[name]!;
  })]));
}
export function config(input: Record<string, unknown>, local = false): Config {
  keys(input, ["template", "params", "name", "enabled", "intervalMinutes"]);
  const { template, params, enabled = true, intervalMinutes = 30 } = input;
  const name = required(input.name, "source name");
  if (name.length > 120 || typeof enabled !== "boolean" || typeof intervalMinutes !== "number" ||
    !Number.isSafeInteger(intervalMinutes * 60_000) || intervalMinutes < 5) throw new SourceError("Invalid source name, interval or enabled flag");
  if (!record(params)) throw new SourceError("Expected source params");
  const base = { name, enabled, intervalMinutes };
  if (template === "github") {
    keys(params, ["token"]);
    return { ...base, template, params: { token: required(params.token, "GitHub token") } };
  }
  if (template !== "json" && template !== "rss") throw new SourceError("Unknown source template");
  const url = requestUrl(params.url, local);
  if (template === "rss") {
    keys(params, ["url"]);
    return { ...base, template, params: { url } };
  }
  keys(params, ["url", "itemsPath", "idField", "titleField", "urlField", "bodyField", "headers", "secrets"]);
  const { itemsPath = "" } = params;
  if (typeof itemsPath !== "string" || (itemsPath && itemsPath.split(".").some(k => !k))) throw new SourceError("Invalid itemsPath");
  const spec = { url, itemsPath, idField: required(params.idField, "idField"), titleField: required(params.titleField, "titleField"),
    urlField: required(params.urlField, "urlField"), ...(params.bodyField != null && { bodyField: required(params.bodyField, "bodyField") }),
    headers: stringMap(params.headers, /^[!#$%&'*+.^_`|~\w-]+$/), secrets: stringMap(params.secrets, /^[\w-]+$/) };
  resolvedHeaders(spec);
  return { ...base, template, params: spec };
}

export function publicParams(spec: Spec) {
  if (spec.template === "github") return { token: { set: true } };
  if (spec.template === "rss") return spec.params;
  const { headers, secrets, ...params } = spec.params;
  const masked = (m: Record<string, string>) => Object.fromEntries(Object.keys(m).map(k => [k, { set: true }]));
  return { ...params, headers: masked(headers), secrets: masked(secrets) };
}
