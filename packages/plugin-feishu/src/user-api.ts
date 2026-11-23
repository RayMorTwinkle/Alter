import type { ExternalEvent } from "@alter/core";
import { Client, defaultHttpInstance, defaultLogger, Domain, LoggerLevel, withUserAccessToken, type HttpInstance } from "@larksuiteoapi/node-sdk";
import type { FeishuConfig } from "./config.ts";

type Chat = { chat_id?: string; name?: string; type: string };
type Message = { sender: string; time?: string; text: string };

export type AccessTokenResponse = { accessToken: string; refreshToken?: string; expiresIn?: number };
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

export interface FeishuUserApi {
  exchange(code: string, redirectUri: string, verifier: string): Promise<AccessTokenResponse>;
  refresh(refreshToken: string): Promise<AccessTokenResponse>;
  name(token: string): Promise<string | undefined>;
  chats(token: string): Promise<Chat[]>;
  messages(token: string, chatId: string, limit: number): Promise<Message[]>;
  watchMessages(token: string, chatId: string, since: number, until: number): Promise<ExternalEvent[]>;
  send(token: string, chatId: string, text: string): Promise<string>;
}

function messageText(type?: string, content?: string) {
  if (type === "text" && content) {
    try {
      const text: unknown = JSON.parse(content)?.text;
      if (typeof text === "string") return text;
    } catch { /* Recalled messages can contain plain text. */ }
  }
  return `[${type ?? "unknown"}]`;
}

async function data<T>(operation: string, request: Promise<{ code?: number; data?: T }>): Promise<T> {
  // SDK transport errors may carry Authorization headers and the entire request body.
  const result = await request.catch(() => { throw new Error(`Feishu ${operation} request failed`); });
  if (result.code !== 0 || !result.data) throw new Error(`Feishu ${operation} failed (${result.code})`);
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
  const data = await res.json().catch(() => ({})) as { code?: number; access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || data.code || !data.access_token) throw new FeishuTokenError(res.status, data.code ?? 0, data.error_description ?? data.error ?? "");
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

export function sdkUserApi(config: FeishuConfig, endpoints?: { domain: string; oauthBaseUrl: string }): FeishuUserApi {
  const base = endpoints?.domain ?? (config.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn");
  const client_id = config.appId, client_secret = config.appSecret;
  const client = new Client({
    appId: config.appId, appSecret: config.appSecret, domain: config.domain === "lark" ? Domain.Lark : Domain.Feishu,
    ...endpoints, disableTokenCache: true, loggerLevel: LoggerLevel.error, logger: { ...defaultLogger, error() {} },
    httpInstance: { ...http, request: options => http.request({ ...options, timeout: 15_000 }) },
  });
  return {
    exchange: (code, redirect_uri, code_verifier) => token(base, { grant_type: "authorization_code", client_id, client_secret, code, redirect_uri, code_verifier }),
    refresh: refresh_token => token(base, { grant_type: "refresh_token", client_id, client_secret, refresh_token }),
    async name(token) {
      return (await data("user_info", client.authen.userInfo.get({}, withUserAccessToken(token)))).name;
    },
    async chats(token) {
      const chats: Chat[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await data("chat.list", client.im.chat.list({
          params: { types: "p2p,group", page_size: 100, page_token: cursor },
        }, withUserAccessToken(token)));
        for (const chat of page.items ?? []) chats.push({ chat_id: chat.chat_id, name: chat.name, type: chat.chat_mode ?? "unknown" });
        if (!page.has_more) break;
        cursor = page.page_token;
        if (!cursor || seen.has(cursor)) throw new Error("Invalid Feishu chat cursor");
        seen.add(cursor);
      } while (cursor);
      return chats;
    },
    async messages(token, chatId, limit) {
      const page = await data("message.list", client.im.message.list({ params: { container_id_type: "chat",
        container_id: chatId, sort_type: "ByCreateTimeDesc", page_size: limit, with_sender_name: true } }, withUserAccessToken(token)));
      return (page.items ?? []).map(item => ({ sender: item.sender?.sender_name || item.sender?.id || "unknown",
        time: item.create_time, text: messageText(item.msg_type, item.body?.content) }));
    },
    async watchMessages(token, chatId, since, until) {
      const events: ExternalEvent[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await data("message.list", client.im.message.list({ params: { container_id_type: "chat", container_id: chatId,
          start_time: String(Math.floor(since / 1000)), end_time: String(Math.ceil(until / 1000)), sort_type: "ByCreateTimeAsc",
          page_size: 50, page_token: cursor, with_sender_name: true } }, withUserAccessToken(token)));
        for (const item of page.items ?? []) {
          const at = Number(item.create_time);
          if (!item.message_id || !Number.isFinite(at) || at < since || at >= until) continue;
          const text = item.msg_type !== "text" && item.body?.content || messageText(item.msg_type, item.body?.content);
          events.push({ source: "feishu", kind: "message", ref: item.message_id, chatId, at, untrusted: true,
            ...(item.sender?.id && { contact: item.sender.id }), ...(item.sender?.sender_name && { contactName: item.sender.sender_name }),
            summary: text.slice(0, 512), text });
        }
        if (!page.has_more) break;
        cursor = page.page_token;
        if (!cursor || seen.has(cursor)) throw new Error("Invalid Feishu message cursor");
        seen.add(cursor);
      } while (cursor);
      return events;
    },
    async send(token, chatId, text) {
      const sent = await data("message.create", client.im.message.create({ params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) } }, withUserAccessToken(token)));
      if (!sent.message_id) throw new Error("Feishu did not confirm message delivery");
      return sent.message_id;
    },
  };
}
