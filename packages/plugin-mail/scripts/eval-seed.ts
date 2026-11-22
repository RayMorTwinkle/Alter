// Host-side fixture. None of these operations are registered as agent tools.
import { setTimeout as sleep } from "node:timers/promises";
import { ImapFlow } from "imapflow";
import { hasCapability } from "imapflow/lib/tools.js";
import { defaultClients, folderPath, imapConnection, uids, withImap, type Message } from "../src/client.ts";
import type { MailConfig } from "../src/config.ts";
import { search } from "../src/read.ts";
import { send } from "../src/send.ts";

export function mailSeed(config: MailConfig, id: string, text: string) {
  const subject = `Alter E2E ${id}`;
  const messageId = `<alter.e2e.${id}@${config.address.split("@")[1]}>`;
  const message: Message = { to: config.address, subject, text };
  let delivered = false;

  async function plant() {
    await withImap(config, defaultClients, client => send(config, defaultClients, client, message, {
      messageId, created: Date.now(), claim: async () => "ready", mark: async () => {},
    }));
    const deadline = AbortSignal.timeout(180_000);
    const client = imapConnection(config, defaultClients);
    const stop = () => client.close();
    deadline.addEventListener("abort", stop, { once: true });
    try {
      await client.connect();
      while (true) {
        deadline.throwIfAborted();
        const rows = await search(client, { subject });
        if (rows.some(row => row.subject === subject)) { delivered = true; return; }
        await sleep(2000, undefined, { signal: deadline });
      }
    } catch (error) {
      if (deadline.aborted) throw new Error(`三分钟内未确认种子到达 INBOX：${subject}`);
      throw error;
    } finally {
      deadline.removeEventListener("abort", stop);
      client.close();
    }
  }

  async function clean() {
    const warnings: string[] = [];
    await withImap(config, defaultClients, async client => {
      if (!(client instanceof ImapFlow)) throw new Error("Expected an ImapFlow connection");
      const sent = folderPath(await client.list(), "Sent");
      for (const path of new Set(["INBOX", sent])) {
        try {
          await client.mailboxOpen(path);
          // 163 ignores SEARCH SUBJECT but honours a Message-ID header search. Expunge only exact envelope matches.
          const candidates = await uids(client, { header: { "Message-ID": messageId } });
          if (!candidates.length) continue;
          const rows = await client.fetchAll(candidates, { envelope: true }, { uid: true });
          const ids = rows.filter(row => row.envelope?.subject === subject && row.envelope.messageId === messageId).map(row => row.uid);
          if (!ids.length) continue;
          // Without UID EXPUNGE ImapFlow could expunge other messages flagged Deleted.
          if (!hasCapability(client, "UIDPLUS")) throw new Error("服务不支持定向 UID EXPUNGE");
          if (!await client.messageDelete(ids, { uid: true }) || (await uids(client, { header: { "Message-ID": messageId } })).length) {
            throw new Error("未确认删除");
          }
        } catch (error) { warnings.push(`${path}：${error instanceof Error ? error.message : String(error)}`); }
      }
    });
    if (!delivered) warnings.push("未确认投递，收件箱可能稍后收到种子");
    if (warnings.length) throw new Error(warnings.join("；"));
  }

  return { subject, messageId, plant, clean };
}
