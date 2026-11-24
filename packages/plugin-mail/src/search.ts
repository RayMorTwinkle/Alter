import type { SearchObject } from "imapflow";
import { uids, type MailConnection } from "./client.ts";
import { addresses, bodyText, parts, resultLimit, summary } from "./read.ts";

type Query = {
  folder?: string; from?: string; to?: string; subject?: string; text?: string; since?: string; before?: string;
  unseen?: boolean; flagged?: boolean; has_attachment?: boolean; limit?: number;
};

function day(value: string) {
  const date = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("Expected a valid YYYY-MM-DD");
  return date;
}

export async function search(client: MailConnection, args: Query) {
  const { folder = "INBOX", from, to, subject, text, unseen, flagged, since, before } = args;
  const limit = resultLimit(args.limit);
  // Coremail returns empty results for text SEARCH keys even when matching mail exists.
  const local = /(^|\.)163\.com$/i.test(client.options?.host ?? "");
  const query: SearchObject = { all: true };
  if (since !== undefined) query.since = day(since);
  if (before !== undefined) query.before = day(before);
  if (unseen !== undefined) query.seen = !unseen;
  if (flagged !== undefined) query.flagged = flagged;
  if (!local) {
    if (from) query.from = from;
    if (to) query.to = to;
    if (subject) query.subject = subject;
    if (text) query.text = text;
  }
  await client.mailboxOpen(folder, { readOnly: true });
  const ids = (await uids(client, query)).sort((a, b) => b - a);
  const results = [];
  const batch = args.has_attachment !== undefined || (local && (from || to || subject || text)) ? 100 : limit;
  const matches = (value: string, needle?: string) => !needle || value.toLowerCase().includes(needle.toLowerCase());
  for (let i = 0; i < ids.length; i += batch) {
    const rows = await client.fetchAll(ids.slice(i, i + batch), {
      envelope: true, internalDate: true, flags: true, bodyStructure: true, ...(local && text && { headers: true }),
    }, { uid: true });
    for (const row of rows.sort((a, b) => b.uid - a.uid)) {
      const env = row.envelope;
      if (local && (!matches(addresses(env?.from, Infinity), from) || !matches(addresses(env?.to, Infinity), to) ||
          !matches(env?.subject ?? "", subject))) continue;
      const { body, attachments } = parts(row.bodyStructure);
      if (args.has_attachment !== undefined && args.has_attachment !== !!attachments.length) continue;
      if (local && text && !matches([row.headers, env?.subject, addresses(env?.from), addresses(env?.to)].join("\n"), text) &&
          !matches((await bodyText(client, row.uid, body, false)).text, text)) continue;
      results.push({ ...summary(row), folder, to: addresses(env?.to), seen: !!row.flags?.has("\\Seen"),
        flagged: !!row.flags?.has("\\Flagged"), attachmentCount: attachments.length });
      if (results.length >= limit) return results;
    }
  }
  return results;
}
