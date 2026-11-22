import {
  ImapFlow, type DownloadNotFound, type DownloadObject, type DownloadOptions, type FetchMessageObject,
  type FetchQueryObject, type ImapFlowOptions, type ListResponse, type MailboxObject, type SearchObject,
} from "imapflow";
import { createTransport } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { validAddress, type MailConfig } from "./config.ts";

type Folder = Pick<ListResponse, "path" | "specialUse" | "flags" | "specialUseSource">;
export interface MailConnection {
  connect(): Promise<void>;
  close(): void;
  on(event: "close" | "error" | "exists", listener: () => void): unknown;
  off(event: "close" | "exists", listener: () => void): unknown;
  list(): Promise<Folder[]>;
  mailboxOpen(path: string, options: { readOnly: true }): Promise<Pick<MailboxObject, "uidValidity" | "uidNext">>;
  search(query: SearchObject, options: { uid: true; strict: true }): Promise<number[] | false | undefined>;
  fetchAll(ids: number[], query: FetchQueryObject, options: { uid: true }): Promise<FetchMessageObject[]>;
  fetchOne(uid: number, query: FetchQueryObject, options: { uid: true }): Promise<FetchMessageObject | false>;
  download(uid: number, part: string, options: DownloadOptions): Promise<DownloadObject | DownloadNotFound>;
  append(path: string, raw: Buffer, flags: string[]): Promise<object | false>;
}
export type Message = { to: string; subject: string; text: string };
export type MailClients = {
  imap(options: ImapFlowOptions): MailConnection;
  smtp(config: MailConfig, to: string, raw: Buffer): Promise<void>;
};
export const defaultClients: MailClients = {
  imap: options => new ImapFlow(options),
  async smtp(config, to, raw) {
    const transport = createTransport({
      ...config.smtp, secure: config.smtp.port === 465 || config.smtp.port === 994, requireTLS: true,
      auth: { user: config.address, pass: config.authCode },
    });
    try {
      await transport.sendMail({ envelope: { from: config.address, to: [to] }, raw });
    } finally {
      transport.close();
    }
  },
};

export function imapConnection(config: MailConfig, clients: MailClients) {
  const startTLS = config.imap.port === 143;
  const client = clients.imap({
    ...config.imap, secure: !startTLS, doSTARTTLS: startTLS,
    auth: { user: config.address, pass: config.authCode },
    clientInfo: { name: "Alter", version: "0.1", vendor: "Alter" }, logger: false,
  });
  // ImapFlow emits socket errors as well as rejecting pending commands.
  client.on("error", () => client.close());
  return client;
}

// Each operation owns its connection and selected mailbox. IDLE uses a separate one.
export async function withImap<T>(config: MailConfig, clients: MailClients, fn: (client: MailConnection) => Promise<T>) {
  const client = imapConnection(config, clients);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    client.close();
  }
}

export function folderPath(folders: Folder[], kind: "Sent" | "Drafts") {
  const flag = `\\${kind}`;
  const special = folders.find(folder => [...folder.flags].some(value => value.toLowerCase() === flag.toLowerCase()) ||
    (folder.specialUse?.toLowerCase() === flag.toLowerCase() && folder.specialUseSource !== "name"));
  return special?.path ?? (kind === "Sent" ? "已发送" : "草稿箱");
}

export async function uids(client: MailConnection, query: SearchObject) {
  const result = await client.search(query, { uid: true, strict: true });
  if (!Array.isArray(result)) throw new Error("Incomplete IMAP SEARCH response");
  return result;
}

export function compose(config: MailConfig, message: Message, messageId?: string, date?: Date) {
  if (!validAddress(message.to)) throw new Error("Expected one recipient email address");
  return new MailComposer({ ...message, from: config.address, messageId, date, newline: "win" }).compile().build();
}

export async function append(client: MailConnection, path: string, raw: Buffer, flags: string[]) {
  if (!await client.append(path, raw, flags)) throw new Error("IMAP APPEND failed");
}
