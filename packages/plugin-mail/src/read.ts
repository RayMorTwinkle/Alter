import { buffer } from "node:stream/consumers";
import type { FetchMessageObject, MessageAddressObject, MessageStructureObject, SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import { reply } from "@alter/core";
import { uids, type MailConnection } from "./client.ts";

type Query = { from?: string; subject?: string; since?: string; unseen?: boolean; limit?: number };
export function addresses(items?: MessageAddressObject[]) {
  return (items ?? []).map(item => item.name && item.address ? `${item.name} <${item.address}>` : item.address ?? item.name).join(", ").slice(0, 1024);
}
export function summary(message: FetchMessageObject) {
  const env = message.envelope;
  return { uid: message.uid, from: addresses(env?.from), subject: (env?.subject ?? "").slice(0, 1024), date: env?.date ?? message.internalDate ?? null };
}
export async function search(client: MailConnection, { from, subject, since, unseen, limit = 20 }: Query) {
  await client.mailboxOpen("INBOX", { readOnly: true });
  const query: SearchObject = { all: true, from, subject };
  if (unseen !== undefined) query.seen = !unseen;
  if (since !== undefined) {
    const date = new Date(since + "T00:00:00Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== since) throw new Error("since requires a valid YYYY-MM-DD");
    query.since = date;
  }
  const ids = (await uids(client, query)).slice(-limit);
  if (!ids.length) return [];
  const messages = await client.fetchAll(ids, { envelope: true, internalDate: true }, { uid: true });
  return messages.sort((a, b) => b.uid - a.uid).map(summary);
}

const bodyLimit = 16_000;
function parts(root: MessageStructureObject) {
  const attachments: { filename: string; type: string; size?: number }[] = [];
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
    attachments.push({ filename: (filename ?? "").slice(0, 512), type: node.type, size: node.size });
    return [];
  }
  return { body: visit(root), attachments };
}

export async function read(client: MailConnection, uid: number) {
  await client.mailboxOpen("INBOX", { readOnly: true });
  const msg = await client.fetchOne(uid, { bodyStructure: true, envelope: true, internalDate: true }, { uid: true });
  if (!msg || !msg.bodyStructure) throw new Error(`Missing INBOX message or body structure for UID ${uid}`);
  const { body, attachments } = parts(msg.bodyStructure);
  let text = "";
  let remainingBytes = 64 * 1024;
  let truncated = false;
  for (const node of body) {
    if (remainingBytes <= 0 || text.length >= bodyLimit) { truncated = true; break; }
    const part = await client.download(uid, node.part || "1", { uid: true, maxBytes: remainingBytes, decodeText: true });
    if (!part.content) throw new Error(`Missing INBOX body for UID ${uid}`);
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
  return { ...summary(msg), to: addresses(msg.envelope?.to), cc: addresses(msg.envelope?.cc),
    replyTo: addresses(msg.envelope?.replyTo), messageId: msg.envelope?.messageId,
    text: text.slice(0, bodyLimit), truncated: truncated || text.length > bodyLimit || remainingBytes <= 0, attachments };
}

export function external(items: { uid: number }[]) {
  const wrapped = items.map(item => {
    const data = JSON.stringify(item).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return `<external source="mail" uid="${item.uid}">${data}</external>`;
  });
  return { ...reply(wrapped.join("\n") || "No matching messages"), details: { untrusted: true, source: "mail" } };
}
