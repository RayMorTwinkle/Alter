import { reply } from "@alter/core";
import { createMailPlugin, type MailConfig } from "@alter/plugin-mail";
import { validAddress } from "../plugin-mail/src/config.ts";

export type CapturedMail = { to: string; text: string };

export function captureMail(config: MailConfig, sent: Map<string, CapturedMail>) {
  const mail = createMailPlugin(config);
  mail.tools = mail.tools.map(tool => tool.name !== "mail_send" ? tool : {
    ...tool, async execute({ to, text }, api) {
      if (typeof to !== "string" || !validAddress(to) || typeof text !== "string") return reply("Invalid message", true);
      const id = `<eval.${api.conversationId}.${api.taskId}@example.invalid>`;
      if (!sent.has(id)) sent.set(id, { to, text });
      return reply(id);
    },
  });
  return mail;
}

export function sentTo(sent: Iterable<CapturedMail>, recipient: string) {
  return Array.from(sent).some(mail => mail.to === recipient);
}
