import { setTimeout as delay } from "node:timers/promises";
import type { ExternalEvent, PluginHost, WatchSource } from "@alter/core";
import { imapConnection, uids, withImap, type MailClients } from "./client.ts";
import type { MailConfig } from "./config.ts";
import type { FetchMessageObject } from "imapflow";
import { read, summary } from "./read.ts";

function receivedAt(row: FetchMessageObject) {
  if (!row.internalDate) return;
  const ms = new Date(row.internalDate).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function mailEvent(row: FetchMessageObject, validity: bigint, at: number): ExternalEvent {
  const { from, subject } = summary(row);
  const sender = row.envelope?.from?.[0];
  return { source: "mail", kind: "new-message", summary: `${from} — ${subject}`, ref: `INBOX/${validity}/${row.uid}`,
    at, untrusted: true,
    ...(sender?.address && { contact: sender.address }), ...(sender?.name && { contactName: sender.name }) };
}

export function mailWatchSource(config: MailConfig, clients: MailClients): WatchSource {
  return {
    async authorize() {
      try { await withImap(config, clients, client => client.mailboxOpen("INBOX", { readOnly: true })); }
      catch { throw new Error("无法读取收件箱，请检查 IMAP 连接和授权"); }
    },
    poll: ({ contact }, since, until) => withImap(config, clients, async client => {
      const box = await client.mailboxOpen("INBOX", { readOnly: true });
      const ids = await uids(client, { since: new Date(since - 86_400_000) });
      const events: ExternalEvent[] = [];
      for (let i = 0; i < ids.length; i += 100) {
        for (const row of await client.fetchAll(ids.slice(i, i + 100), { envelope: true, internalDate: true }, { uid: true })) {
          const at = receivedAt(row);
          if (at === undefined) throw new Error("IMAP 未返回收件时间");
          const event = mailEvent(row, box.uidValidity, at);
          if (event.at < since || event.at >= until || (contact && ![event.contact, event.contactName].some(v => v?.toLowerCase() === contact.toLowerCase()))) continue;
          event.text = event.summary + "\n" + (await read(client, row.uid)).text;
          events.push(event);
        }
      }
      return events;
    }),
  };
}

// Servers without IDLE (163) get a search every pollMs instead of push wake-ups.
export async function watchInbox(config: MailConfig, clients: MailClients, host: PluginHost, pollMs = 60_000) {
  const controller = new AbortController();
  const { signal } = controller;
  let connected!: () => void;
  const ready = new Promise<void>(resolve => { connected = resolve; });
  let cursor: { validity: bigint; next: number } | undefined;

  async function run() {
    let backoff = 1000;
    while (!signal.aborted) {
      const client = imapConnection(config, clients);
      let closed = false;
      let dirty = true;
      let wake: (() => void) | undefined;
      const changed = () => { dirty = true; wake?.(); };
      const dropped = () => { closed = true; changed(); };
      const stop = () => { dropped(); client.close(); };
      client.on("close", dropped);
      client.on("exists", changed);
      signal.addEventListener("abort", stop, { once: true });
      let poll: NodeJS.Timeout | undefined;
      try {
        await client.connect();
        const box = await client.mailboxOpen("INBOX", { readOnly: true });
        if (!cursor || cursor.validity !== box.uidValidity) {
          cursor = { validity: box.uidValidity, next: box.uidNext ?? ((await uids(client, { all: true })).at(-1) ?? 0) + 1 };
        }
        if (!client.capabilities.has("IDLE")) poll = setInterval(changed, pollMs);
        connected();
        // ImapFlow automatically enters IDLE when the command queue is empty. An
        // EXISTS count is only a wake-up: UIDs survive expunges and reconnects.
        while (!closed && !signal.aborted) {
          if (!dirty) await new Promise<void>(resolve => { wake = resolve; });
          if (closed || signal.aborted) break;
          dirty = false;
          // IMAP ranges are reversible: "next:*" can return the previous last UID.
          const next = cursor.next;
          const ids = (await uids(client, { uid: `${next}:*` })).filter(uid => uid >= next);
          for (let offset = 0; offset < ids.length; offset += 50) {
            const rows = await client.fetchAll(ids.slice(offset, offset + 50), { envelope: true, internalDate: true }, { uid: true });
            for (const row of rows.sort((a, b) => a.uid - b.uid)) {
              if (signal.aborted) return;
              const event = mailEvent(row, cursor.validity, receivedAt(row) ?? Date.now());
              if (await host.watching?.(event)) {
                try { event.text = event.summary + "\n" + (await read(client, row.uid)).text; }
                catch { console.warn("Alter mail watch could not read body for", event.ref); }
              }
              await host.emit(event);
              cursor.next = row.uid + 1;
            }
          }
          backoff = 1000;
        }
      } catch (error) {
        if (!signal.aborted) console.warn("Alter mail INBOX watch interrupted:", error instanceof Error ? error.message : "IMAP error");
      } finally {
        clearInterval(poll);
        connected();
        signal.removeEventListener("abort", stop);
        client.off("exists", changed);
        client.off("close", dropped);
        client.close();
      }
      if (!signal.aborted) {
        await delay(backoff, undefined, { signal });
        backoff = Math.min(60_000, backoff * 2);
      }
    }
  }
  const running = run().catch(error => { if (!signal.aborted) throw error; });
  await Promise.race([ready, running]);
  return async () => { controller.abort(); await running; };
}
