import { defineTool, reply, schema, type AlterPlugin } from "@alter/core";
import { append, compose, defaultClients, folderPath, withImap, type MailClients } from "./client.ts";
import { validAddress, type MailConfig } from "./config.ts";
import { external, ownSent, read, search } from "./read.ts";
import { send, toolAttempt } from "./send.ts";
import { mailWatchSource, watchInbox } from "./watch.ts";

export { mailConfigFromEnv, type MailConfig } from "./config.ts";
export type { MailClients, MailConnection } from "./client.ts";

const { bool, int, obj, opt, str } = schema;
const message = obj({ to: str({ description: "One recipient email address" }), subject: str(), text: str() });
export function createMailPlugin(config: MailConfig, clients: MailClients = defaultClients, connection?: (ok: boolean) => void): AlterPlugin {
  return {
    capability: { id: "mail", mainLeasable: false, actions: [
      { name: "search", effect: "read" }, { name: "read", effect: "read" },
      { name: "draft", effect: "write-local" }, { name: "send", effect: "external-send" },
    ] },
    describe({ tool, arguments: { to } }) {
      if ((tool !== "mail_send" && tool !== "mail_draft") || typeof to !== "string" || !validAddress(to)) return;
      const at = to.indexOf("@");
      return { to: to.slice(0, at + 1) + to.slice(at + 1).toLowerCase() };
    },
    tools: [
      defineTool({
        name: "mail_search", description: "Search INBOX, newest first. from and subject are case-insensitive substrings matched within the newest 500 messages that satisfy since and unseen.", replay: "safe",
        parameters: obj({ from: opt(str()), subject: opt(str()), since: opt(str({ description: "YYYY-MM-DD" })),
          unseen: opt(bool()), limit: opt(int({ minimum: 1, maximum: 50 })) }),
        execute: args => withImap(config, clients, async client => external(await search(client, args))),
      }),
      defineTool({
        name: "mail_read", description: "Read INBOX headers, text and attachment names by UID.", replay: "safe",
        parameters: obj({ uid: int({ minimum: 1, maximum: 4294967295 }) }),
        execute: ({ uid }) => withImap(config, clients, async client => external([await read(client, uid)])),
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
    ],
    ownMessages: (since, until) => withImap(config, clients, client => ownSent(client, config.address, since, until)),
    watchSource: mailWatchSource(config, clients),
    start: host => watchInbox(config, clients, host, undefined, connection),
  };
}

export { mailDescription, mailInstance } from "./settings.ts";
