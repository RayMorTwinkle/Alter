import { reply, schema } from "@alter/core";
import { createMailPlugin, type MailConfig } from "@alter/plugin-mail";
import { defaultClients, withImap, type Message } from "../plugin-mail/src/client.ts";
import { validAddress } from "../plugin-mail/src/config.ts";
import { forwardMessage, replyMessage, type ForwardArgs, type ReplyArgs } from "../plugin-mail/src/thread.ts";

export type CapturedMail = { to: string | string[]; text: string };

export function captureMail(config: MailConfig, sent: Map<string, CapturedMail>) {
  const mail = createMailPlugin(config);
  mail.tools = mail.tools.map(tool => {
    if (!["mail_send", "mail_reply", "mail_forward"].includes(tool.name)) return tool;
    const validate = schema.compile(tool.parameters!).check;
    return { ...tool, async execute(args, api) {
      if (!validate(args)) return reply("Invalid message", true);
      const id = `<eval.${api.conversationId}.${api.taskId}@example.invalid>`;
      if (sent.has(id)) return reply(id);
      let message: Message;
      if (tool.name === "mail_send") {
        message = args as Message;
        if (typeof message.to !== "string" || !validAddress(message.to)) return reply("Invalid recipient", true);
      } else {
        message = await withImap(config, defaultClients, client => tool.name === "mail_reply"
          ? replyMessage(client, config.address, args as ReplyArgs) : forwardMessage(client, args as ForwardArgs));
      }
      const recipients = [message.to, message.cc ?? []].flat();
      sent.set(id, { to: recipients.length === 1 ? recipients[0]! : recipients, text: message.text });
      return reply(id);
    } };
  });
  return mail;
}

export function sentTo(sent: Iterable<CapturedMail>, recipient: string) {
  return Array.from(sent).some(mail => [mail.to].flat().includes(recipient));
}
