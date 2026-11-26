import { join } from "node:path";
import { dataDirectory, defineTool, reply, schema, withStrictToolArguments, type AlterPlugin } from "@alter/core";
import { saveAttachment } from "./attachment.ts";
import { append, compose, defaultClients, folderPath, withImap, type MailClients } from "./client.ts";
import { validAddress, type MailConfig } from "./config.ts";
import { contacts, folders, mark, move } from "./mailbox.ts";
import { external, ownSent, read } from "./read.ts";
import { search } from "./search.ts";
import { send, toolAttempt } from "./send.ts";
import { forwardMessage, replyMessage, replyRecipients } from "./thread.ts";
import { mailWatchSource, watchInbox } from "./watch.ts";

export { mailConfigFromEnv, type MailConfig } from "./config.ts";
export type { MailClients, MailConnection } from "./client.ts";

const { arr, bool, int, obj, opt, str } = schema;
const message = obj({ to: str({ description: "One recipient email address" }), subject: str(), text: str() });
const folder = opt(str({ minLength: 1, description: "Mailbox path from mail_folders. Defaults to INBOX." }));
const uid = int({ minimum: 1, maximum: 4294967295 });
const ids = arr(uid, { minItems: 1, uniqueItems: true });
const limit = opt(int({ minimum: 1, maximum: 100, description: "Default 20" }));
const date = opt(str({ description: "YYYY-MM-DD" }));
export function createMailPlugin(config: MailConfig, clients: MailClients = defaultClients, connection?: (ok: boolean) => void): AlterPlugin {
  return {
    capability: { id: "mail", mainLeasable: true, actions: [
      { name: "folders", effect: "read" }, { name: "search", effect: "read" }, { name: "read", effect: "read" },
      { name: "attachment", effect: "read" }, { name: "contacts", effect: "read" },
      { name: "draft", effect: "write" }, { name: "send", effect: "write" }, { name: "reply", effect: "write" },
      { name: "forward", effect: "write" }, { name: "mark", effect: "write" }, { name: "move", effect: "write" },
    ] },
    async describe({ tool, arguments: args }) {
      const { to } = args;
      if (tool === "mail_reply" && typeof args.uid === "number") {
        const uid = args.uid;
        return withImap(config, clients, async client => {
          await client.mailboxOpen(typeof args.folder === "string" ? args.folder : "INBOX", { readOnly: true });
          const msg = await client.fetchOne(uid, { envelope: true }, { uid: true });
          if (!msg || !msg.envelope) return;
          const targets = replyRecipients(msg.envelope, config.address, args.reply_all === true);
          return { to: [...targets.to, ...targets.cc].join(", ") };
        });
      }
      if (tool === "mail_forward" && Array.isArray(to) && to.length && to.every(v => typeof v === "string" && validAddress(v))) return { to: to.join(", ") };
      if ((tool !== "mail_send" && tool !== "mail_draft") || typeof to !== "string" || !validAddress(to)) return;
      const at = to.indexOf("@");
      return { to: to.slice(0, at + 1) + to.slice(at + 1).toLowerCase() };
    },
    tools: [
      defineTool({
        name: "mail_folders", description: "List mailbox paths, special uses, total and unread counts.", replay: "safe", parameters: obj({}),
        execute: () => withImap(config, clients, async client => external(await folders(client), "No folders")),
      }),
      defineTool({
        name: "mail_search", description: "Find messages in a folder, newest UID first. Combine address, subject, full-text, date, flag and attachment filters. since is inclusive, before exclusive.", replay: "safe",
        parameters: obj({ folder, from: opt(str()), to: opt(str()), subject: opt(str()), text: opt(str()), since: date, before: date,
          unseen: opt(bool()), flagged: opt(bool()), has_attachment: opt(bool()), limit }),
        execute: args => withImap(config, clients, async client => external(await search(client, args))),
      }),
      defineTool({
        name: "mail_read", description: "Read headers, thread IDs, body text and numbered attachments by folder and UID.", replay: "safe",
        parameters: obj({ folder, uid }),
        execute: args => withImap(config, clients, async client => external([await read(client, args.uid, args.folder)])),
      }),
      defineTool({
        name: "mail_attachment", description: "Download one attachment by its 1-based index from mail_read. Returns the local path, MIME type and byte size.",
        parameters: obj({ folder, uid, index: int({ minimum: 1 }) }), replay: "safe",
        execute: args => withImap(config, clients, async client => external([await saveAttachment(client,
          config.dataDir ?? join(dataDirectory(), "mail"), config.address, args.folder ?? "INBOX", args.uid, args.index)])),
      }),
      defineTool({
        name: "mail_contacts", description: "Find correspondents by name or address in the latest 1,500 messages per folder in INBOX and Sent, most frequent first.",
        parameters: obj({ query: opt(str()), limit }), replay: "safe",
        execute: args => withImap(config, clients, async client => external(await contacts(client, config.address, args.query, args.limit), "No matching contacts")),
      }),
      defineTool({
        name: "mail_draft", description: "Save a plain text draft.", parameters: message,
        execute: args => withImap(config, clients, async client => {
          const path = folderPath(await client.list(), "Drafts");
          await append(client, path, await compose(config, args), ["\\Draft"]);
          return reply("Draft saved");
        }),
      }),
      defineTool({
        name: "mail_send", description: "Send mail and return its Message-ID. Each new tool call is a new send. Report uncertain delivery to the user.",
        parameters: message, replay: "safe",
        execute: (args, api, ctx) => withImap(config, clients, async client =>
          reply(await send(config, clients, client, args, await toolAttempt(config, args.to, api, ctx)))),
      }),
      defineTool({
        name: "mail_reply", description: "Send a threaded reply to Reply-To or the sender. reply_all also includes original To and Cc, excluding yourself. Returns Message-ID.",
        parameters: obj({ folder, uid, text: str(), reply_all: opt(bool()) }), replay: "safe",
        execute: (args, api, ctx) => withImap(config, clients, async client => reply(await send(config, clients, client,
          () => replyMessage(client, config.address, args), await toolAttempt(config, undefined, api, ctx,
            JSON.stringify(["reply", args.folder ?? "INBOX", args.uid, args.reply_all ?? false]))))),
      }),
      defineTool({
        name: "mail_forward", description: "Forward a message to one or more addresses with an optional introduction. Includes original attachments by default. Returns Message-ID.",
        parameters: obj({ folder, uid, to: arr(str(), { minItems: 1 }), text: opt(str()), include_attachments: opt(bool()) }), replay: "safe",
        execute: (args, api, ctx) => withImap(config, clients, async client => reply(await send(config, clients, client,
          () => forwardMessage(client, args), await toolAttempt(config, args.to.join(","), api, ctx,
            JSON.stringify(["forward", args.folder ?? "INBOX", args.uid, args.include_attachments ?? true]))))),
      }),
      withStrictToolArguments(defineTool({
        name: "mail_mark", description: "Set or clear seen and/or flagged for the specified UIDs. Other flags are preserved.",
        parameters: obj({ folder, uids: ids, seen: opt(bool()), flagged: opt(bool()) }),
        execute: args => withImap(config, clients, async client => {
          await mark(client, args.folder ?? "INBOX", args.uids, args.seen, args.flagged);
          return reply("Flags updated");
        }),
      }), ({ seen, flagged }) => seen === undefined && flagged === undefined ? 'provide at least one of "seen" or "flagged"' : undefined),
      defineTool({
        name: "mail_move", description: "Move the specified UIDs to an existing destination mailbox. UIDs are local to each folder.",
        parameters: obj({ folder, uids: ids, destination: str({ minLength: 1 }) }),
        execute: args => withImap(config, clients, async client => {
          await move(client, args.folder ?? "INBOX", args.uids, args.destination);
          return reply("Messages moved");
        }),
      }),
    ],
    ownMessages: (since, until) => withImap(config, clients, client => ownSent(client, config.address, since, until)),
    watchSource: mailWatchSource(config, clients),
    start: host => watchInbox(config, clients, host, undefined, connection),
  };
}

export { mailDescription, mailInstance } from "./settings.ts";
