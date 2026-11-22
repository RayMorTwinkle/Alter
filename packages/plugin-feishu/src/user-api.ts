import { Client, defaultHttpInstance, defaultLogger, Domain, LoggerLevel, withUserAccessToken, type AccessTokenResponse, type HttpInstance } from "@larksuiteoapi/node-sdk";
import type { FeishuConfig } from "./config.ts";

type Chat = { chat_id?: string; name?: string; type: string };
type Message = { sender: string; time?: string; text: string };

export interface FeishuUserApi {
  exchange(code: string, redirectUri: string, verifier: string): Promise<AccessTokenResponse>;
  refresh(refreshToken: string): Promise<AccessTokenResponse>;
  name(token: string): Promise<string | undefined>;
  chats(token: string): Promise<Chat[]>;
  messages(token: string, chatId: string, limit: number): Promise<Message[]>;
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

export function sdkUserApi(config: FeishuConfig, endpoints?: { domain: string; oauthBaseUrl: string }): FeishuUserApi {
  const client = new Client({
    appId: config.appId, appSecret: config.appSecret, domain: config.domain === "lark" ? Domain.Lark : Domain.Feishu,
    ...endpoints, disableTokenCache: true, loggerLevel: LoggerLevel.error, logger: { ...defaultLogger, error() {} },
    httpInstance: { ...http, request: options => http.request({ ...options, timeout: 15_000 }) },
  });
  return {
    exchange: (code, redirectUri, verifier) => client.accessToken.retrieveByAuthorizationCode({ code, redirectUri, codeVerifier: verifier }),
    refresh: refreshToken => client.accessToken.refresh({ refreshToken }),
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
    async send(token, chatId, text) {
      const sent = await data("message.create", client.im.message.create({ params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) } }, withUserAccessToken(token)));
      if (!sent.message_id) throw new Error("Feishu did not confirm message delivery");
      return sent.message_id;
    },
  };
}
