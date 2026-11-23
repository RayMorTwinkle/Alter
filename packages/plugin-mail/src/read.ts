import { buffer } from "node:stream/consumers";
import type { FetchMessageObject, MessageAddressObject, MessageStructureObject, SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import { reply } from "@alter/core";
import { folderPath, uids, type MailConnection } from "./client.ts";

type Query = { from?: string; subject?: string; since?: string; unseen?: boolean; limit?: number };
export function addresses(items?: MessageAddressObject[]) {
  return (items ?? []).map(item => item.name && item.address ? `${item.name} <${item.address}>` : item.address ?? item.name).join(", ").slice(0, 1024);
}
export function summary(message: FetchMessageObject) {
  const env = message.envelope;
  return { uid: message.uid, from: addresses(env?.from), subject: (env?.subject ?? "").slice(0, 1024), date: env?.date ?? message.internalDate ?? null };
}
// 163 (Coremail) answers SEARCH FROM / SUBJECT / TEXT with nothing, while dates and flags work.
// So the server narrows by date and flags, and sender and subject match on envelopes here.
export const scanWindow = 500;
const contains = (value: string, needle?: string) => needle === undefined || value.toLowerCase().includes(needle.toLowerCase());

export async function search(client: MailConnection, { from, subject, since, unseen, limit = 20 }: Query) {
  await client.mailboxOpen("INBOX", { readOnly: true });
  const query: SearchObject = { all: true };
  if (unseen !== undefined) query.seen = !unseen;
  if (since !== undefined) {
    const date = new Date(since + "T00:00:00Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== since) throw new Error("since requires a valid YYYY-MM-DD");
    query.since = date;
  }
  const filtered = from !== undefined || subject !== undefined;
  const ids = (await uids(client, query)).slice(filtered ? -scanWindow : -limit);
  if (!ids.length) return [];
  const messages = await client.fetchAll(ids, { envelope: true, internalDate: true }, { uid: true });
  return messages.sort((a, b) => b.uid - a.uid).map(summary)
    .filter(row => contains(row.from, from) && contains(row.subject, subject)).slice(0, limit);
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
  return readSelected(client, uid);
}

async function readSelected(client: MailConnection, uid: number) {
  const msg = await client.fetchOne(uid, { bodyStructure: true, envelope: true, internalDate: true }, { uid: true });
  if (!msg || !msg.bodyStructure) throw new Error(`Missing message or body structure for UID ${uid}`);
  const { body, attachments } = parts(msg.bodyStructure);
  let text = "";
  let remainingBytes = 64 * 1024;
  let truncated = false;
  for (const node of body) {
    if (remainingBytes <= 0 || text.length >= bodyLimit) { truncated = true; break; }
    const part = await client.download(uid, node.part || "1", { uid: true, maxBytes: remainingBytes, decodeText: true });
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
  return { ...summary(msg), to: addresses(msg.envelope?.to), cc: addresses(msg.envelope?.cc),
    replyTo: addresses(msg.envelope?.replyTo), messageId: msg.envelope?.messageId,
    text: text.slice(0, bodyLimit), truncated: truncated || text.length > bodyLimit || remainingBytes <= 0, attachments };
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
      const { text } = await readSelected(client, row.uid);
      const quote = text.search(/^\s*(?:>|-{2,}\s*(?:Original Message|Forwarded message|原始邮件|转发)|Begin forwarded message:|On .+ wrote:|在.+写道[：:]|(?:From|发件人)[:：])/im);
      const threaded = e.inReplyTo || /^(re|fw|fwd|回复|转发)[:：]/i.test(e.subject ?? "");
      if (threaded && quote < 0) continue;
      const own = (quote < 0 ? text : text.slice(0, quote)).trim();
      if (own) messages.push({ at, text: own, id: e.messageId ?? `Sent/${box.uidValidity}/${row.uid}` });
    }
  }
  return messages;
}

export function external(items: { uid: number }[]) {
  const wrapped = items.map(item => {
    const data = JSON.stringify(item).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return `<external source="mail" uid="${item.uid}">${data}</external>`;
  });
  return { ...reply(wrapped.join("\n") || "No matching messages"), details: { untrusted: true, source: "mail" } };
}
