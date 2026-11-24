import { buffer } from "node:stream/consumers";
import type { MessageAddressObject, MessageEnvelopeObject } from "imapflow";
import { attachmentStream } from "./attachment.ts";
import type { MailConnection, Message } from "./client.ts";
import { validAddress } from "./config.ts";
import { addresses, bodyText, parts, references, selectedMessage } from "./read.ts";

type Source = { folder?: string; uid: number };
export type ReplyArgs = Source & { text: string; reply_all?: boolean };
export type ForwardArgs = Source & { to: string[]; text?: string; include_attachments?: boolean };

export function replyRecipients(env: MessageEnvelopeObject, self: string, replyAll = false) {
  const used = new Set<string>();
  function recipients(items?: MessageAddressObject[]) {
    const result: string[] = [];
    for (const { address } of items ?? []) {
      if (!address || !validAddress(address)) throw new Error("Invalid reply recipient");
      const key = address.toLowerCase();
      if (!used.has(key)) result.push(address);
      used.add(key);
    }
    return result;
  }
  const isSelf = (p: MessageAddressObject) => p.address?.toLowerCase() === self.toLowerCase();
  const own = env.from?.length === 1 && isSelf(env.from[0]!);
  const sentToOthers = own && env.to?.some(p => !isSelf(p));
  const primary = env.replyTo?.length ? env.replyTo : (sentToOthers ? env.to : env.from);
  if (replyAll || (own && primary === env.to)) used.add(self.toLowerCase());
  const to = recipients(primary);
  const cc = replyAll ? recipients([...(env.to ?? []), ...(env.cc ?? [])]) : [];
  if (!to.length && !cc.length && primary?.some(isSelf)) to.push(self);
  if (!to.length && !cc.length) throw new Error("No reply recipients");
  return { to, cc };
}

export async function replyMessage(client: MailConnection, self: string, args: ReplyArgs): Promise<Message> {
  await client.mailboxOpen(args.folder ?? "INBOX", { readOnly: true });
  const msg = await client.fetchOne(args.uid, { envelope: true, headers: ["References"] }, { uid: true });
  if (!msg || !msg.envelope) throw new Error(`Missing envelope for UID ${args.uid}`);
  const env = msg.envelope;
  const { to, cc } = replyRecipients(env, self, args.reply_all);
  if (!env.messageId) throw new Error("Cannot thread reply without original Message-ID");
  const refs = await references(msg);
  if (!refs.length && env.inReplyTo) refs.push(env.inReplyTo);
  const subject = env.subject ?? "";
  return { to, cc, text: args.text, subject: /^re:/i.test(subject) ? subject : "Re: " + subject,
    inReplyTo: env.messageId, references: [...new Set([...refs, env.messageId])] };
}

export async function forwardMessage(client: MailConnection, args: ForwardArgs): Promise<Message> {
  if (!args.to.length || !args.to.every(validAddress)) throw new Error("Expected valid forward recipients");
  await client.mailboxOpen(args.folder ?? "INBOX", { readOnly: true });
  const msg = await selectedMessage(client, args.uid);
  const { body, attachments } = parts(msg.bodyStructure);
  const env = msg.envelope;
  const subject = env?.subject ?? "";
  const original = ["---------- Forwarded message ----------", "From: " + addresses(env?.from, Infinity),
    "Date: " + (env?.date ?? msg.internalDate ?? ""), "Subject: " + subject, "To: " + addresses(env?.to, Infinity),
    ...(env?.cc?.length ? ["Cc: " + addresses(env.cc, Infinity)] : []), "", (await bodyText(client, args.uid, body, false)).text];
  const files = [];
  if (args.include_attachments !== false) {
    for (const item of attachments) files.push({ filename: item.filename || "attachment-" + item.index, contentType: item.type,
      content: await buffer(await attachmentStream(client, args.uid, item.part)) });
  }
  return { to: args.to, subject: /^fwd?:/i.test(subject) ? subject : "Fwd: " + subject,
    text: [...(args.text ? [args.text, ""] : []), ...original].join("\n"), attachments: files };
}
