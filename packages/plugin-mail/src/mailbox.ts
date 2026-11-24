import { ImapFlow } from "imapflow";
import { hasCapability } from "imapflow/lib/tools.js";
import { folderPath, uids, type MailConnection } from "./client.ts";
import { resultLimit } from "./read.ts";

export async function folders(client: MailConnection) {
  const rows = await client.list({ statusQuery: { messages: true, unseen: true } });
  return rows.map(row => {
    const special = row.specialUse ?? [...row.flags].find(flag => /^\\(Sent|Drafts|Trash|Junk|Archive|All|Flagged|Inbox)$/i.test(flag));
    return { name: row.path, specialUse: special?.replace(/^\\/, "") ?? null,
      total: row.status?.messages ?? null, unread: row.status?.unseen ?? null };
  });
}

export async function contacts(client: MailConnection, self: string, query = "", requestedLimit?: number) {
  const limit = resultLimit(requestedLimit);
  const byAddress = new Map<string, { name: string; address: string; count: number; lastAt: string | null }>();
  const seenMessages = new Set<string>();
  const sent = folderPath(await client.list(), "Sent");
  for (const folder of new Set(["INBOX", sent])) {
    const box = await client.mailboxOpen(folder, { readOnly: true });
    if (box.exists === 0) continue;
    const ids = (await uids(client, box.exists ? { seq: `${Math.max(1, box.exists - 1499)}:*` } : { all: true }))
      .sort((a, b) => b - a).slice(0, 1500);
    for (let i = 0; i < ids.length; i += 100) {
      const rows = await client.fetchAll(ids.slice(i, i + 100), { envelope: true, internalDate: true }, { uid: true });
      for (const row of rows) {
        const e = row.envelope;
        if (!e || (e.messageId && seenMessages.has(e.messageId))) continue;
        if (e.messageId) seenMessages.add(e.messageId);
        const at = new Date(e.date ?? row.internalDate ?? NaN);
        const lastAt = Number.isFinite(at.getTime()) ? at.toISOString() : null;
        const counted = new Set([self.toLowerCase()]);
        for (const { address, name } of [...(e.from ?? []), ...(e.to ?? []), ...(e.cc ?? []), ...(e.bcc ?? [])]) {
          const key = address?.toLowerCase();
          if (!address || !key || counted.has(key)) continue;
          counted.add(key);
          const contact = byAddress.get(key) ?? { address, name: "", count: 0, lastAt: null };
          contact.count++;
          if (name && (!contact.name || (lastAt ?? "") >= (contact.lastAt ?? ""))) contact.name = name;
          if (lastAt && lastAt > (contact.lastAt ?? "")) contact.lastAt = lastAt;
          byAddress.set(key, contact);
        }
      }
    }
  }
  const needle = query.toLowerCase();
  return [...byAddress.values()].filter(row => [row.name, row.address].some(s => s.toLowerCase().includes(needle)))
    .sort((a, b) => b.count - a.count || (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || a.address.localeCompare(b.address)).slice(0, limit);
}

async function selectUids(client: MailConnection, folder: string, ids: number[]) {
  if (!ids.length) throw new Error("Expected message UIDs");
  await client.mailboxOpen(folder, { readOnly: false });
  const found = new Set(await uids(client, { uid: ids.join(",") }));
  const missing = ids.filter(id => !found.has(id));
  if (missing.length) throw new Error(`Missing UID(s) in ${folder}: ${missing.join(", ")}`);
}

export async function mark(client: MailConnection, folder: string, ids: number[], seen?: boolean, flagged?: boolean) {
  if (seen === undefined && flagged === undefined) throw new Error("Provide seen or flagged");
  await selectUids(client, folder, ids);
  for (const value of [true, false]) {
    const flags = [];
    if (seen === value) flags.push("\\Seen");
    if (flagged === value) flags.push("\\Flagged");
    if (!flags.length) continue;
    const ok = value ? await client.messageFlagsAdd(ids, flags, { uid: true }) : await client.messageFlagsRemove(ids, flags, { uid: true });
    if (!ok) throw new Error(`Could not update ${flags.join(", ")}`);
  }
}

export async function move(client: MailConnection, folder: string, ids: number[], destination: string) {
  if (destination === folder || (folder.toUpperCase() === "INBOX" && destination.toUpperCase() === "INBOX")) throw new Error("Choose a different destination");
  await selectUids(client, folder, ids);
  // ImapFlow emulates MOVE with COPY + EXPUNGE. Only UID EXPUNGE preserves unrelated deleted messages.
  const supports = (key: string) => client instanceof ImapFlow ? hasCapability(client, key) : client.capabilities.has(key);
  if (!supports("MOVE") && !supports("UIDPLUS")) throw new Error("Moving specific UIDs requires MOVE or UIDPLUS");
  if (!await client.messageMove(ids, destination, { uid: true })) throw new Error("IMAP move failed; check both folders before retrying");
}
