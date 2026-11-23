import { defineTool, reply, schema, type AlterPlugin } from "@alter/core";
import { openAccount } from "./account.ts";
import type { FeishuUserConfig } from "./config.ts";
import { sdkUserApi, type FeishuUserApi } from "./user-api.ts";

const { obj, opt, int, str } = schema;
const chat_id = str({ minLength: 1 });
const disconnected = "飞书账号未连接，请在 Web 设置中连接";
function externalText(rows: object[]) {
  const text = JSON.stringify(rows).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<external source="feishu">${text}</external>`;
}

export function createFeishuConnector(options: { config: FeishuUserConfig; dataDir: string; api?: FeishuUserApi; now?: () => number; changed?: () => void }) {
  const api = options.api ?? sdkUserApi(options.config);
  const account = openAccount(options.config, options.dataDir, api, options.now ?? Date.now, options.changed);
  async function read(fetchRows: (token: string) => Promise<object[]>) {
    const token = await account.accessToken();
    const result = token ? reply(externalText(await fetchRows(token))) : reply(disconnected, true);
    return { ...result, details: { untrusted: true, source: "feishu" } };
  }
  async function userToken() {
    const token = await account.accessToken();
    if (!token) throw new Error(disconnected);
    return token;
  }
  const plugin: AlterPlugin = {
    capability: { id: "feishu", mainLeasable: true, actions: [
      { name: "chats", effect: "read" }, { name: "messages", effect: "read" }, { name: "send", effect: "external-send" },
    ] },
    async describe({ tool, arguments: { chat_id } }) {
      if ((tool !== "feishu_send" && tool !== "feishu_messages") || typeof chat_id !== "string") return;
      const chat = (await api.chats(await userToken())).find(chat => chat.chat_id === chat_id);
      if (chat?.name) return { chat_id, name: chat.name, type: chat.type };
    },
    start: account.watch,
    watchSource: {
      async authorize({ chatId }) {
        const token = await userToken();
        if (chatId) await api.messages(token, chatId, 1);
        else {
          const checked = new Set<string>();
          for (const chat of await api.chats(token)) {
            if (!chat.chat_id || checked.has(chat.type)) continue;
            await api.messages(token, chat.chat_id, 1);
            checked.add(chat.type);
          }
        }
      },
      async poll({ chatId }, since, until) {
        const token = await userToken();
        const ids = chatId ? [chatId] : (await api.chats(token)).flatMap(chat => chat.chat_id ? [chat.chat_id] : []);
        const events = [];
        for (const id of ids) events.push(...await api.watchMessages(token, id, since, until));
        return events;
      },
    },
    tools: [
      defineTool({ name: "feishu_chats", description: "List the user's Feishu chats with names, IDs and types.",
        parameters: obj({}), replay: "safe", execute: () => read(token => api.chats(token)) }),
      defineTool({ name: "feishu_messages", description: "Read recent Feishu messages, newest first. Times are Unix milliseconds.",
        parameters: obj({ chat_id, limit: opt(int({ minimum: 1, maximum: 50 })) }), replay: "safe",
        execute: args => read(token => api.messages(token, args.chat_id, args.limit ?? 20)) }),
      defineTool({ name: "feishu_send", description: "Send a text message as the connected Feishu user.",
        parameters: obj({ chat_id, text: str({ minLength: 1 }) }), async execute(args) {
          const token = await account.accessToken();
          return token ? reply(await api.send(token, args.chat_id, args.text)) : reply(disconnected, true);
        } }),
    ],
  };
  const { start, callback, status, disconnect } = account;
  return { plugin, account: { start, callback, status, disconnect } };
}
