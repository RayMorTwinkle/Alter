import { Readable } from "node:stream";
import type { ExternalEvent } from "@alter/core";
import { Client, defaultHttpInstance, defaultLogger, Domain, LoggerLevel, withUserAccessToken, type HttpInstance } from "@larksuiteoapi/node-sdk";
import type { FeishuConfig } from "./config.ts";
import { formatMessage, inRange, type TimeRange } from "./messages.ts";

type ListOptions = TimeRange & { limit?: number; order?: "asc" | "desc"; page_token?: string };
type SearchOptions = TimeRange & { query: string; chat_id?: string; from?: string; page_token?: string };
type Contact = { open_id: string; name?: string; email?: string; department?: string };
type DirectoryHit = { id: string; display_info?: string; meta_data?: { i18n_names?: Record<string, string>;
  mail_address?: string; enterprise_mail_address?: string; department?: string } };
type Cursor = { has_more?: boolean; page_token?: string };
type Page<T> = { items: T[]; page_token?: string };
type Envelope<T> = { code?: number; data?: T };

function page<T>(items: T[], result: Cursor, current?: string): Page<T> {
  if (result.has_more && (!result.page_token || result.page_token === current)) throw new Error("Invalid Feishu page token");
  return { items, ...(result.has_more && { page_token: result.page_token }) };
}

export async function allItems<T>(fetchPage: (cursor?: string) => Promise<Page<T>>) {
  const items: T[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const next = await fetchPage(cursor);
    items.push(...next.items);
    cursor = next.page_token;
    if (cursor && seen.has(cursor)) throw new Error("Repeated Feishu page token");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}

function pathId(id: string) {
  if (!id || id === "." || id === ".." || /[\\/]/.test(id)) throw new Error("Invalid Feishu ID or resource key");
  return encodeURIComponent(id);
}

export type AccessTokenResponse = { accessToken: string; refreshToken?: string; expiresIn?: number; scopes?: string[] };
export class FeishuTokenError extends Error {
  readonly statusCode: number;
  readonly code: number;
  constructor(statusCode: number, code: number, description: string) {
    super(description || "Feishu token request failed");
    this.name = "FeishuTokenError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export type FeishuUserApi = ReturnType<typeof sdkUserApi>;

class ApiError extends Error {
  readonly unavailable: boolean;
  constructor(operation: string, code?: number, status?: number) {
    const scope = code === 99991672 || code === 99991676 || code === 99991679;
    super(`Feishu ${operation} failed (${code ?? status ?? "network"})` + (scope ? "，请核对应用权限并重新连接飞书账号。" : ""));
    this.unavailable = [403, 404, 405].includes(status ?? 0) || (status !== undefined && status >= 500) || scope;
  }
}

async function request<T>(operation: string, promise: Promise<T>) {
  // SDK errors can include request headers and bodies. Preserve only numeric diagnostics.
  try { return await promise; } catch (error) {
    const response = (error as { response?: { status?: number; data?: { code?: number } } })?.response;
    if (response?.data instanceof Readable) response.data.destroy();
    throw new ApiError(operation, response?.data?.code, response?.status);
  }
}

async function data<T>(operation: string, promise: Promise<Envelope<T>>): Promise<T> {
  const result = await request(operation, promise);
  if (result.code !== 0 || !result.data) throw new ApiError(operation, result.code);
  return result.data;
}

// The SDK response interceptor unwraps Axios responses to the HttpInstance body type.
const http = defaultHttpInstance as HttpInstance;

// The SDK's accessToken client targets /oauth/v3/token, which does not verify PKCE for codes
// from /authen/v1/authorize. Use the documented v2 token endpoint directly.
async function token(base: string, body: Record<string, string>): Promise<AccessTokenResponse> {
  const res = await fetch(`${base}/open-apis/authen/v2/oauth/token`, {
    method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({})) as { code?: number; access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
  if (!res.ok || data.code || !data.access_token) throw new FeishuTokenError(res.status, data.code ?? 0, data.error_description ?? data.error ?? "");
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in, scopes: data.scope?.split(/\s+/).filter(Boolean) };
}

export function sdkUserApi(config: FeishuConfig, endpoints?: { domain: string; oauthBaseUrl: string }) {
  const base = endpoints?.domain ?? (config.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn");
  const client_id = config.appId, client_secret = config.appSecret;
  const client = new Client({
    appId: config.appId, appSecret: config.appSecret, domain: config.domain === "lark" ? Domain.Lark : Domain.Feishu,
    ...endpoints, disableTokenCache: true, loggerLevel: LoggerLevel.error, logger: { ...defaultLogger, error() {} },
    httpInstance: { ...http, request: options => http.request({ ...options, timeout: 15_000 }) },
  });
  async function chats(token: string, cursor?: string, types = "p2p,group", size = 100) {
    const result = await data("chat.list", client.im.chat.list({ params: { types, page_size: size, page_token: cursor,
      user_id_type: "open_id", sort_type: "ByActiveTimeDesc" } }, withUserAccessToken(token)));
    return page((result.items ?? []).map(chat => ({ chat_id: chat.chat_id, name: chat.name, type: chat.chat_mode ?? "unknown",
      peer_id: chat.p2p_target_id, peer_type: chat.p2p_target_type })), result, cursor);
  }

  async function history(token: string, id: string, options: ListOptions = {}, container = "chat") {
    const { start_time, end_time, order, page_token, limit } = options;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) throw new Error("limit 须为 1 至 50 的整数");
    const result = await data("message.list", client.im.message.list({ params: { container_id_type: container, container_id: id,
      start_time: start_time === undefined ? undefined : String(Math.floor(start_time / 1000)),
      end_time: end_time === undefined ? undefined : String(Math.ceil(end_time / 1000)),
      sort_type: order === "asc" ? "ByCreateTimeAsc" : "ByCreateTimeDesc", page_size: limit ?? 20, page_token,
      with_sender_name: true } }, withUserAccessToken(token)));
    const items = (result.items ?? []).filter(item => inRange(Number(item.create_time), options));
    return page(items, result, page_token);
  }

  async function messages(token: string, id: string, options: ListOptions = {}) {
    const result = await history(token, id, options);
    return { ...result, items: result.items.map(item => formatMessage({ ...item, chat_id: item.chat_id ?? id })) };
  }

  async function members(token: string, chatId: string, cursor?: string) {
    const result = await data("chatMembers.get", client.im.chatMembers.get({ path: { chat_id: pathId(chatId) },
      params: { member_id_type: "open_id", page_token: cursor, page_size: 100 } }, withUserAccessToken(token)));
    const items = (result.items ?? []).flatMap(m => m.member_id ? [{ open_id: m.member_id, name: m.name }] : []);
    return { ...page(items, result, cursor), ...(result.trigger_security_conf_limit && { notice: "飞书限制了可见的成员数量。" }) };
  }

  return {
    exchange: (code: string, redirect_uri: string, code_verifier: string) => token(base, { grant_type: "authorization_code", client_id, client_secret, code, redirect_uri, code_verifier }),
    refresh: (refresh_token: string) => token(base, { grant_type: "refresh_token", client_id, client_secret, refresh_token }),
    async name(token: string) {
      return (await data("user_info", client.authen.userInfo.get({}, withUserAccessToken(token)))).name;
    },
    chats, messages, members,
    async search(token: string, options: SearchOptions) {
      const { query, chat_id, from, start_time, end_time, page_token } = options;
      const local = page_token?.startsWith("local:");
      if (!local) {
        const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
        try {
          const result = await data("message.search", client.im.message.search({ params: { user_id_type: "open_id", page_size: 30, page_token },
            data: { query, filter: { chat_ids: chat_id ? [chat_id] : undefined, from_ids: from ? [from] : undefined,
              time_range: start_time === undefined && end_time === undefined ? undefined : {
                start_time: start_time === undefined ? undefined : iso(start_time),
                end_time: end_time === undefined ? undefined : iso(Math.ceil(end_time / 1000) * 1000) } } } }, withUserAccessToken(token)));
          const items = (result.items ?? []).flatMap(hit => {
            const meta = hit.meta_data;
            if (meta?.create_time && !inRange(Date.parse(meta.create_time), options)) return [];
            return [{ message_id: meta?.message_id || hit.id, text: hit.display_info?.replace(/<\/?h>/g, ""),
              chat_id: meta?.chat_id, sender_id: meta?.from_id, time: meta?.create_time, type: meta?.type, thread_id: meta?.thread_id }];
          });
          return { ...page(items, result, page_token), source: "search", notice: result.notice };
        } catch (error) {
          if (page_token || !(error instanceof ApiError && error.unavailable)) throw error;
        }
      }
      const recent = chat_id ? [chat_id] : (await chats(token, undefined, "p2p,group", 10)).items.flatMap(c => c.chat_id ?? []);
      const items = [];
      let next: string | undefined;
      for (const id of recent) {
        const found = await messages(token, id, { ...options, page_token: local ? page_token!.slice(6) : undefined, limit: 50 });
        items.push(...found.items.filter(m => (!from || m.sender_id === from) && m.text.toLowerCase().includes(query.toLowerCase())));
        if (chat_id && found.page_token) next = "local:" + found.page_token;
      }
      return { source: "local", items, page_token: next, notice: chat_id ? "原生搜索不可用，逐页筛选此会话的消息。" :
        "原生搜索不可用，仅筛选最近活跃的 10 个会话在时间范围内最新的各 50 条消息。" };
    },
    async message(token: string, id: string) {
      const result = await data("message.get", client.im.message.get({ path: { message_id: pathId(id) },
        params: { with_sender_name: true, user_id_type: "open_id" } }, withUserAccessToken(token)));
      const items = (result.items ?? []).map(item => formatMessage(item, true));
      const main = items.find(item => item.message_id === id);
      if (!main) throw new Error("Feishu did not return the requested message");
      if (!main.thread_id) return { items };
      try {
        const thread = main.thread_id;
        const replies = await allItems(cursor => history(token, thread, { page_token: cursor, order: "asc", limit: 50 }, "thread"));
        return { items, replies: replies.filter(reply => reply.message_id !== id).map(item => formatMessage(item, true)) };
      } catch (error) { return { items, notice: `话题回复未能展开：${(error as Error).message}` }; }
    },
    async download(token: string, id: string, key: string, type: "file" | "image") {
      const res = await request("messageResource.get", client.im.messageResource.get({
        path: { message_id: pathId(id), file_key: pathId(key) }, params: { type } }, withUserAccessToken(token)));
      const stream = res.getReadableStream();
      const disposition = String(res.headers["content-disposition"] ?? "");
      const mime: string | undefined = res.headers["content-type"];
      return { stream, disposition, mime };
    },
    async contacts(token: string, query?: string, cursor?: string) {
      const fallback = cursor?.startsWith("p2p:");
      if (!fallback) {
        try {
          // This user-only endpoint is not generated in SDK 1.76.
          const result = await data("contact.search", client.request<Envelope<Cursor & { items: DirectoryHit[]; notice?: string }>>({
            method: "POST", url: "/open-apis/contact/v3/users/search", params: { page_size: 30, page_token: cursor },
            data: query ? { query } : { filter: { has_contact: true } } }, withUserAccessToken(token)));
          const items = (result.items ?? []).map(hit => {
            const meta = hit.meta_data, names = meta?.i18n_names;
            const line = hit.display_info?.split("\n")[1]?.trim();
            return { open_id: hit.id, name: names?.zh_cn || names?.en_us || Object.values(names ?? {})[0] || hit.id,
              email: meta?.mail_address || meta?.enterprise_mail_address, department: meta?.department || (line?.startsWith("[") ? undefined : line) };
          });
          if (result.has_more && !result.page_token) return { items, source: "directory", notice: result.notice || "飞书限制了结果数量，请缩小搜索范围。" };
          if (items.length || result.has_more || cursor) return { ...page(items, result, cursor), source: "directory", notice: result.notice };
        } catch (error) {
          if (cursor || !(error instanceof ApiError && error.unavailable)) throw error;
        }
      }
      const result = await chats(token, fallback ? cursor!.slice(4) : undefined, "p2p");
      const peers = new Map<string, Contact>();
      for (const chat of result.items) {
        if (chat.type !== "p2p" || chat.peer_type === "bot") continue;
        const contacts = chat.peer_id ? [{ open_id: chat.peer_id, name: chat.name }] :
          chat.chat_id ? await allItems(cursor => members(token, chat.chat_id!, cursor)) : [];
        for (const peer of contacts) if (!query || peer.name?.toLowerCase().includes(query.toLowerCase()) || peer.open_id === query) {
          peers.set(peer.open_id, peer);
        }
      }
      return { items: [...peers.values()], page_token: result.page_token && "p2p:" + result.page_token, source: "p2p",
        notice: "通讯录搜索未返回可用结果，仅列出单聊中可见的联系人，可按名字或 open_id 匹配。" };
    },
    async watchMessages(token: string, chatId: string, since: number, until: number) {
      const items = await allItems(cursor => history(token, chatId, { start_time: since, end_time: until, order: "asc", limit: 50, page_token: cursor }));
      return items.flatMap((item): ExternalEvent[] => {
        if (!item.message_id) return [];
        const text = item.msg_type !== "text" && item.body?.content || formatMessage(item).text;
        return [{ source: "feishu", kind: "message", ref: item.message_id, chatId, at: Number(item.create_time), untrusted: true,
          ...(item.sender?.id && { contact: item.sender.id }), ...(item.sender?.sender_name && { contactName: item.sender.sender_name }),
          summary: text.slice(0, 512), text }];
      });
    },
    async send(token: string, id: string, text: string, type: "chat_id" | "open_id" = "chat_id") {
      const sent = await data("message.create", client.im.message.create({ params: { receive_id_type: type },
        data: { receive_id: id, msg_type: "text", content: JSON.stringify({ text }) } }, withUserAccessToken(token)));
      if (!sent.message_id) throw new Error("Feishu did not confirm message delivery");
      return sent.message_id;
    },
    async reply(token: string, id: string, text: string, inThread?: boolean) {
      const sent = await data("message.reply", client.im.message.reply({ path: { message_id: pathId(id) },
        data: { msg_type: "text", content: JSON.stringify({ text }), reply_in_thread: inThread } }, withUserAccessToken(token)));
      if (!sent.message_id) throw new Error("Feishu did not confirm reply delivery");
      return sent.message_id;
    },
  };
}
