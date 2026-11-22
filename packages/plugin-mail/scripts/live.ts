import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadRepoEnv } from "@alter/core";
import { append, compose, defaultClients, folderPath, withImap } from "../src/client.ts";
import { mailConfigFromEnv } from "../src/config.ts";
import { read, search } from "../src/read.ts";
import { inSent, send, type SendAttempt } from "../src/send.ts";
import { watchInbox } from "../src/watch.ts";

loadRepoEnv();
const config = mailConfigFromEnv(process.env);
if (!config) throw new Error("Set ALTER_MAIL_ADDRESS to run the 163 live check");

await withImap(config, defaultClients, async client => {
  const folders = await client.list();
  console.table(folders.map(({ path, specialUse }) => ({ path, specialUse })));
  const recent = await search(client, { limit: 5 });
  console.table(recent);
  if (recent[0]) {
    const message = await read(client, recent[0].uid);
    console.log("Read UID", message.uid, "body characters", message.text.length, "attachments", message.attachments.length);
  }
  const message = { to: config.address, subject: "Alter 163 live check", text: new Date().toISOString() };
  await append(client, folderPath(folders, "Drafts"), await compose(config, message), ["\\Draft"]);
  console.log("Draft saved");
  // Each explicit invocation is a new self-send, with no replay across invocations.
  const attempt: SendAttempt = {
    messageId: `<alter.live.${randomUUID()}@${config.address.split("@")[1]}>`,
    created: Date.now(), claim: async () => "ready", mark: async () => {},
  };
  const id = await send(config, defaultClients, client, message, attempt);
  if (!await inSent(client, id)) throw new Error(`Message missing from Sent: ${id}`);
  console.log("Verified in Sent", id);
});
// 163 has no IDLE, so this also covers the polling fallback: watch, self-send, wait for the event.
let received = 0;
const stop = await watchInbox(config, defaultClients, {
  async emit(event) { received++; console.log(event); },
}, 10_000);
try {
  const probe = { to: config.address, subject: "Alter 163 watch check", text: new Date().toISOString() };
  await defaultClients.smtp(config, config.address, await compose(config, probe));
  console.log("Watching INBOX for 30 seconds after a self-sent probe.");
  await delay(30_000);
} finally {
  await stop();
  console.log("New messages observed during the watch check:", received);
  if (!received) process.exitCode = 1;
}
