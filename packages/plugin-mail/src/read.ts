import { buffer } from "node:stream/consumers";
import type { FetchMessageObject, MessageAddressObject, MessageStructureObject } from "imapflow";
import { simpleParser } from "mailparser";
import { reply } from "@alter/core";
import { folderPath, uids, type MailConnection } from "./client.ts";

export function resultLimit(value = 20) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("limit must be an integer from 1 to 100");
  return value;
}

export function addresses(items?: MessageAddressObject[], limit = 1024) {
  return (items ?? []).map(item => item.name && item.address ? `${item.name} <${item.address}>` : item.address ?? item.name).join(", ").slice(0, limit);
}
export function summary(message: FetchMessageObject) {
  const env = message.envelope;
  return { uid: message.uid, from: addresses(env?.from), subject: (env?.subject ?? "").slice(0, 1024), date: env?.date ?? message.internalDate ?? null };
}
const bodyLimit = 16_000;
export function parts(root?: MessageStructureObject) {
  const attachments: { index: number; part: string; filename: string; type: string; size: number | null }[] = [];
  function visit(node: MessageStructureObject): MessageStructureObject[] {
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
    if (node.disposition !== "attachment" && !filename) {
      if (node.type === "text/plain" || node.type === "text/html") return [node];
      if (node.type.startsWith("multipart/")) {
        const children = (node.childNodes ?? []).flatMap(visit);
        if (node.type !== "multipart/alternative") return children;
        const preferred = children.find(child => child.type === "text/plain") ?? children[0];
        return preferred ? [preferred] : [];
      }
    }
    attachments.push({ index: attachments.length + 1, part: node.part || "1", filename: (filename ?? "").slice(0, 512), type: node.type, size: node.size ?? null });
    return [];
  }
  return { body: root ? visit(root) : [], attachments };
}

export async function selectedMessage(client: MailConnection, uid: number) {
  const msg = await client.fetchOne(uid, { bodyStructure: true, envelope: true, internalDate: true, headers: ["References"] }, { uid: true });
  if (!msg || !msg.bodyStructure) throw new Error(`Missing message or body structure for UID ${uid}`);
  return msg;
}

export async function references(msg: FetchMessageObject) {
  const refs = msg.headers && (await simpleParser(msg.headers)).references;
  return refs ? [refs].flat() : [];
}

export async function bodyText(client: MailConnection, uid: number, body: MessageStructureObject[], bounded = true) {
  let text = "";
  let remainingBytes = bounded ? 64 * 1024 : Infinity;
  let truncated = false;
  for (const node of body) {
    if (remainingBytes <= 0 || (bounded && text.length >= bodyLimit)) { truncated = true; break; }
    const part = await client.download(uid, node.part || "1", { uid: true, ...(bounded && { maxBytes: remainingBytes }), decodeText: true });
    if (!part.content) throw new Error(`Missing mail body for UID ${uid}`);
    const bytes = await buffer(part.content);
    remainingBytes -= bytes.length;
    let chunk = bytes.toString("utf8");
    if (node.type === "text/html") {
      const parsed = await simpleParser(Buffer.concat([Buffer.from("Content-Type: text/html; charset=utf-8\r\n\r\n"), bytes]),
        { skipTextToHtml: true, skipImageLinks: true });
      chunk = parsed.text ?? "";
    }
    text += (text ? "\n" : "") + chunk;
  }
  return { text: bounded ? text.slice(0, bodyLimit) : text, truncated: bounded && (truncated || text.length > bodyLimit || remainingBytes <= 0) };
}

export async function read(client: MailConnection, uid: number, folder = "INBOX") {
  await client.mailboxOpen(folder, { readOnly: true });
  return readSelected(client, uid, folder);
}

async function readSelected(client: MailConnection, uid: number, folder: string) {
  const msg = await selectedMessage(client, uid);
  const { body, attachments } = parts(msg.bodyStructure);
  return { ...summary(msg), folder, to: addresses(msg.envelope?.to), cc: addresses(msg.envelope?.cc),
    bcc: addresses(msg.envelope?.bcc), replyTo: addresses(msg.envelope?.replyTo), inReplyTo: msg.envelope?.inReplyTo ?? null,
    messageId: msg.envelope?.messageId ?? null, references: await references(msg),
    ...await bodyText(client, uid, body), attachments: attachments.map(({ part, ...info }) => info) };
}

export async function ownSent(client: MailConnection, address: string, since: number, until: number) {
  const sent = folderPath(await client.list(), "Sent");
  const box = await client.mailboxOpen(sent, { readOnly: true });
  const ids = await uids(client, { since: new Date(since - 86_400_000), before: new Date(until + 86_400_000) });
  const messages = [];
  for (let i = 0; i < ids.length; i += 50) {
    const rows = await client.fetchAll(ids.slice(i, i + 50), { envelope: true, internalDate: true }, { uid: true });
    for (const row of rows) {
      const e = row.envelope;
      const at = row.internalDate ? new Date(row.internalDate).getTime() : NaN;
      if (!(at >= since && at <= until) || e?.from?.length !== 1 || e.from[0]?.address?.toLowerCase() !== address.toLowerCase()) continue;
      if (e.messageId?.startsWith("<alter.")) continue;
      const { text } = await readSelected(client, row.uid, sent);
      const quote = text.search(/^\s*(?:>|-{2,}\s*(?:Original Message|Forwarded message|原始邮件|转发)|Begin forwarded message:|On .+ wrote:|在.+写道[：:]|(?:From|发件人)[:：])/im);
      const threaded = e.inReplyTo || /^(re|fw|fwd|回复|转发)[:：]/i.test(e.subject ?? "");
      if (threaded && quote < 0) continue;
      const own = (quote < 0 ? text : text.slice(0, quote)).trim();
      if (own) messages.push({ at, text: own, id: e.messageId ?? `Sent/${box.uidValidity}/${row.uid}` });
    }
  }
  return messages;
}

export function external<T extends object>(items: T[], empty = "No matching messages") {
  const wrapped = items.map(item => {
    const data = JSON.stringify(item).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const uid = "uid" in item && typeof item.uid === "number" ? ` uid="${item.uid}"` : "";
    return `<external source="mail"${uid}>${data}</external>`;
  });
  return { ...reply(wrapped.join("\n") || empty), details: { untrusted: true, source: "mail" } };
}
