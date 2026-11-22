import { setTimeout as delay } from "node:timers/promises";
import type { PluginHost } from "@alter/core";
import { imapConnection, uids, type MailClients } from "./client.ts";
import type { MailConfig } from "./config.ts";
import { summary } from "./read.ts";

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
            const rows = await client.fetchAll(ids.slice(offset, offset + 50), { envelope: true }, { uid: true });
            for (const row of rows.sort((a, b) => a.uid - b.uid)) {
              if (signal.aborted) return;
              const { from, subject } = summary(row);
              await host.emit({ source: "mail", kind: "new-message", summary: `${from} — ${subject}`,
                ref: `INBOX/${cursor.validity}/${row.uid}`, at: Date.now(), untrusted: true });
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
