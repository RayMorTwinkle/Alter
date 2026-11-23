import { isApprovalDecision, type ApprovalDecision } from "@alter/core";
import { Client, Domain, EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
import type { FeishuConfig } from "./config.ts";

export type FeishuMessage = {
  id: string; openId?: string; chatId: string; chatType: string; type: string;
  text?: string; content?: string; at: number;
};
type CardAction = { openId?: string; messageId?: string; requestId?: string; decision?: ApprovalDecision };
type Toast = { toast: { type: "success" | "error" | "info"; content: string } };
export type FeishuHandlers = {
  message(message: FeishuMessage): Promise<void>;
  action(action: CardAction): Promise<Toast>;
};
export type FeishuTransport = {
  start(handlers: FeishuHandlers): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  sendCard(chatId: string, card: object, uuid: string): Promise<string>;
  updateCard(messageId: string, card: object): Promise<void>;
  close(): Promise<void>;
};

type RawAction = {
  operator?: { open_id?: string }; context?: { open_message_id?: string };
  action?: { value?: { requestId?: unknown; allow?: unknown; decision?: unknown } };
};

export function dispatcher(handlers: FeishuHandlers) {
  return new EventDispatcher({ loggerLevel: LoggerLevel.warn }).register({
    "im.message.receive_v1": ({ sender, message }) => {
      let text: string | undefined;
      if (message.message_type === "text") {
        const parsed = JSON.parse(message.content)?.text;
        if (typeof parsed === "string") {
          // Match whole SDK placeholders so @_user_1 also works alongside @_user_10.
          const mentions = new Set(message.mentions?.map(mention => mention.key));
          text = parsed.replace(/@_user_\d+/g, key => mentions.has(key) ? "" : key).trim();
        }
      }
      return handlers.message({ id: message.message_id, openId: sender.sender_type === "user" ? sender.sender_id?.open_id : undefined,
        chatId: message.chat_id, chatType: message.chat_type, type: message.message_type, text,
        ...(message.message_type !== "text" && { content: message.content }),
        at: Number(message.create_time) || Date.now() });
    },
    "card.action.trigger": ({ operator, context, action }: RawAction) => {
      const value = action?.value;
      return handlers.action({ openId: operator?.open_id, messageId: context?.open_message_id,
        requestId: typeof value?.requestId === "string" ? value.requestId : undefined,
        decision: isApprovalDecision(value?.decision) ? value.decision : value?.decision === undefined && typeof value?.allow === "boolean" ? (value.allow ? "once" : "deny") : undefined });
    },
  });
}

export function sdkTransport(config: FeishuConfig): FeishuTransport {
  const options = { ...config, domain: config.domain === "lark" ? Domain.Lark : Domain.Feishu, loggerLevel: LoggerLevel.warn };
  const client = new Client(options);
  const ws = new WSClient(options);
  async function send(chatId: string, type: "text" | "interactive", content: object, uuid?: string) {
    const result = await client.im.message.create({ params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: type, content: JSON.stringify(content), uuid } });
    if (result.code || !result.data?.message_id) throw new Error(`Feishu message.create failed (${result.code})`);
    return result.data.message_id;
  }
  return {
    start: handlers => ws.start({ eventDispatcher: dispatcher(handlers) }),
    async sendText(chatId, text) { await send(chatId, "text", { text }); },
    sendCard: (chatId, card, uuid) => send(chatId, "interactive", card, uuid),
    async updateCard(messageId, card) {
      const result = await client.im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } });
      if (result.code) throw new Error(`Feishu message.patch failed (${result.code})`);
    },
    async close() { ws.close({ force: true }); },
  };
}
