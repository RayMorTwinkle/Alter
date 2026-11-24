import type { Client } from "@larksuiteoapi/node-sdk";

type MessagePage = NonNullable<Awaited<ReturnType<Client["im"]["message"]["list"]>>["data"]>;
type RawMessage = NonNullable<MessagePage["items"]>[number];
type Resource = { type: "image" | "file"; file_key: string; file_name?: string };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown) { return typeof value === "string" ? value : undefined; }

export function formatMessage(item: RawMessage, full = false) {
  const raw = item.body?.content;
  let body: Record<string, unknown> = {};
  try { if (raw) body = object(JSON.parse(raw)); } catch { /* Recalled messages can contain plain text. */ }
  const resources: Resource[] = [];
  function collect(node: Record<string, unknown>) {
    const file_name = string(node.file_name);
    if (typeof node.image_key === "string") resources.push({ type: "image", file_key: node.image_key, file_name });
    if (typeof node.file_key === "string") resources.push({ type: "file", file_key: node.file_key, file_name });
  }
  collect(body);
  let text = string(body.text) ?? (item.msg_type === "text" && raw ? raw : `[${item.msg_type ?? "unknown"}]`);
  if (item.msg_type === "post") {
    const post = Array.isArray(body.content) ? body : object(body.zh_cn ?? body.en_us ?? Object.values(body)[0]);
    const lines = Array.isArray(post.content) ? post.content.filter(Array.isArray).map(line => line.map(value => {
      const node = object(value);
      collect(node);
      return string(node.text) ?? string(node.user_name) ?? string(node.href) ?? string(node.file_name)
        ?? string(node.user_id) ?? (node.tag === "img" ? "[image]" : "");
    }).join("")) : [];
    text = [string(post.title), ...lines].filter(value => value !== undefined).join("\n") || text;
  }
  const names = new Map(item.mentions?.map(m => [m.key, m.name]));
  text = text.replace(/@_user_\d+/g, key => names.get(key) ? "@" + names.get(key) : key);
  const localized = item.sender?.sender_i18n_names;
  const sender = item.sender?.sender_name || localized?.zh_cn || localized?.en_us || localized?.ja_jp || item.sender?.id || "unknown";
  return { message_id: item.message_id, chat_id: item.chat_id, sender,
    time: item.create_time, text, sender_id: item.sender?.id, type: item.msg_type, thread_id: item.thread_id,
    parent_id: item.parent_id, root_id: item.root_id, upper_message_id: item.upper_message_id, resources,
    ...(full && raw && { content: raw }) };
}

export type TimeRange = { start_time?: number; end_time?: number };
export function timeRange(args: { start_time?: string | number; end_time?: string | number }) {
  function millis(value?: string | number) {
    if (value === undefined) return;
    const ms = typeof value === "number" || /^\d+$/.test(value) ? Number(value)
      : /^\d{4}-\d\d-\d\d(?:T|$)/i.test(value) ? Date.parse(value) : NaN;
    if (!Number.isSafeInteger(ms) || ms < 0 || !Number.isFinite(new Date(ms).getTime())) throw new Error("时间须为 ISO 日期时间或 Unix 毫秒");
    return ms;
  }
  const start_time = millis(args.start_time), end_time = millis(args.end_time);
  if (start_time !== undefined && end_time !== undefined && start_time >= end_time) throw new Error("start_time 必须早于 end_time");
  return { start_time, end_time };
}

export function inRange(at: number, range: TimeRange) {
  return (range.start_time === undefined || at >= range.start_time) && (range.end_time === undefined || at < range.end_time);
}
