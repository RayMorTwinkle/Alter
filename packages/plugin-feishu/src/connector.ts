import { defineTool, reply, schema, withStrictToolArguments, type AlterPlugin } from "@alter/core";
import { openAccount } from "./account.ts";
import type { FeishuUserConfig } from "./config.ts";
import { saveResource } from "./download.ts";
import { timeRange } from "./messages.ts";
import { allItems, sdkUserApi, type FeishuUserApi } from "./user-api.ts";

const { obj, opt, int, str, bool, oneOf, union } = schema;
const id = str({ minLength: 1 });
const page_token = opt(id);
const time = opt(union([str({ minLength: 1 }), int({ minimum: 0 })]));
const times = { start_time: time, end_time: time };
const chat_id = id;
const disconnected = "飞书账号未连接，请在 Web 设置中连接";
function externalText(rows: object) {
  const text = JSON.stringify(rows).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<external source="feishu">${text}</external>`;
}

export function createFeishuConnector(options: { config: FeishuUserConfig; dataDir: string; api?: FeishuUserApi; now?: () => number; changed?: () => void }) {
  const api = options.api ?? sdkUserApi(options.config);
  const account = openAccount(options.config, options.dataDir, api, options.now ?? Date.now, options.changed);
  async function read(fetchRows: (token: string) => Promise<object>) {
    const details = { untrusted: true, source: "feishu" };
    try {
      const value = await fetchRows(await userToken());
      return { ...reply(externalText(value)), details };
    } catch (error) { return { ...reply((error as Error).message, true), details }; }
  }
  async function write(send: (token: string) => Promise<string>) {
    try { return reply(await send(await userToken())); }
    catch (error) { return reply((error as Error).message, true); }
  }
  function allChats(token: string) { return allItems(cursor => api.chats(token, cursor)); }
  async function userToken() {
    const token = await account.accessToken();
    if (!token) throw new Error(disconnected);
    return token;
  }
  const plugin: AlterPlugin = {
    capability: { id: "feishu", mainLeasable: true, actions: [
      ...["chats", "messages", "search", "message", "download", "contacts", "chat_members"].map(name => ({ name, effect: "read" as const })),
      { name: "send", effect: "write" }, { name: "reply", effect: "write" },
    ] },
    async describe({ tool, arguments: { chat_id } }) {
      if ((tool !== "feishu_send" && tool !== "feishu_messages") || typeof chat_id !== "string") return;
      const chat = (await allChats(await userToken())).find(chat => chat.chat_id === chat_id);
      if (chat?.name) return { chat_id, name: chat.name, type: chat.type };
    },
    start: account.watch,
    watchSource: {
      async authorize({ chatId }) {
        const token = await userToken();
        if (chatId) await api.messages(token, chatId, { limit: 1 });
        else {
          const checked = new Set<string>();
          for (const chat of await allChats(token)) {
            if (!chat.chat_id || checked.has(chat.type)) continue;
            await api.messages(token, chat.chat_id, { limit: 1 });
            checked.add(chat.type);
          }
        }
      },
      async poll({ chatId }, since, until) {
        const token = await userToken();
        const ids = chatId ? [chatId] : (await allChats(token)).flatMap(chat => chat.chat_id ? [chat.chat_id] : []);
        const events = [];
        for (const id of ids) events.push(...await api.watchMessages(token, id, since, until));
        return events;
      },
    },
    tools: [
      defineTool({ name: "feishu_chats", description: "List one page of Feishu chats. Filter chat names by query. Follow page_token even on empty filtered pages.",
        parameters: obj({ query: opt(id), page_token }), replay: "safe", execute: args => read(async token => {
          const result = await api.chats(token, args.page_token);
          const query = args.query?.toLowerCase();
          return { ...result, items: result.items.filter(chat => !query || chat.name?.toLowerCase().includes(query)) };
        }) }),
      defineTool({ name: "feishu_messages", description: "Read a page of chat messages with senders, text, resource keys and thread IDs. Order desc (newest first) or asc. Times are ISO or Unix milliseconds, start inclusive and end exclusive.",
        parameters: obj({ chat_id, ...times, page_token, limit: opt(int({ minimum: 1, maximum: 50 })), order: opt(oneOf(["asc", "desc"])) }),
        replay: "safe", execute: args => read(token => api.messages(token, args.chat_id, { ...timeRange(args), page_token: args.page_token,
          order: args.order, limit: args.limit })) }),
      defineTool({ name: "feishu_search", description: "Search the user's visible Feishu messages by keyword. Filter by chat, sender open_id (from), or ISO/millisecond time range. If unavailable, scan the specified chat page by page, or up to 50 messages per chat in the 10 most recently active chats.",
        parameters: obj({ query: id, chat_id: opt(id), from: opt(id), ...times, page_token }), replay: "safe",
        execute: args => read(token => api.search(token, { ...args, ...timeRange(args) })) }),
      defineTool({ name: "feishu_message", description: "Read a complete message by message_id, including merged forwards and accessible thread replies.",
        parameters: obj({ message_id: id }), replay: "safe", execute: args => read(token => api.message(token, args.message_id)) }),
      defineTool({ name: "feishu_download", description: "Download an image or file using the message_id, file_key and type from a message. Returns its local absolute path, type and byte size.",
        parameters: obj({ message_id: id, file_key: id, type: oneOf(["image", "file"]) }), replay: "safe",
        execute: args => read(async token => saveResource(options.dataDir, args.file_key, args.type,
          await api.download(token, args.message_id, args.file_key, args.type))) }),
      defineTool({ name: "feishu_contacts", description: "Find visible contacts by name, email or phone, or list people you have chatted with. Falls back to direct-chat peers. Returns open IDs and available profile fields.",
        parameters: obj({ query: opt(str({ minLength: 1, maxLength: 50 })), page_token }), replay: "safe",
        execute: args => read(token => api.contacts(token, args.query, args.page_token)) }),
      defineTool({ name: "feishu_chat_members", description: "List a page of members of a Feishu chat with names and open IDs.",
        parameters: obj({ chat_id, page_token }), replay: "safe", execute: args => read(token => api.members(token, args.chat_id, args.page_token)) }),
      defineTool({ name: "feishu_reply", description: "Reply to a specific message as the connected Feishu user. Set in_thread to reply in its topic.",
        parameters: obj({ message_id: id, text: id, in_thread: opt(bool()) }),
        execute: args => write(token => api.reply(token, args.message_id, args.text, args.in_thread)) }),
      withStrictToolArguments(defineTool({ name: "feishu_send", description: "Send text as the connected user. Provide exactly one chat_id or open_id. Optional receive_id_type must match the supplied ID.",
        parameters: obj({ chat_id: opt(id), open_id: opt(id), receive_id_type: opt(oneOf(["chat_id", "open_id"])), text: id }),
        execute: args => write(token => {
          const type = args.chat_id ? "chat_id" : "open_id";
          return api.send(token, (args.chat_id ?? args.open_id)!, args.text, type);
        }) }), ({ chat_id, open_id, receive_id_type }) => {
          if ((chat_id === undefined) === (open_id === undefined)) return 'provide exactly one of "chat_id" or "open_id"';
          const target = chat_id === undefined ? "open_id" : "chat_id";
          if (receive_id_type !== undefined && receive_id_type !== target) return '"receive_id_type" must match the supplied "' + target + '"';
        }),
    ],
  };
  const { start, callback, status, disconnect } = account;
  return { plugin, account: { start, callback, status, disconnect } };
}
