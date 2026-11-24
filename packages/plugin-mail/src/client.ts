import { createHash } from "node:crypto";
import {
  ImapFlow, type DownloadNotFound, type DownloadObject, type DownloadOptions, type FetchMessageObject,
  type FetchQueryObject, type ImapFlowOptions, type ListOptions, type ListResponse, type MailboxObject, type SearchObject,
} from "imapflow";
import { createTransport } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { validAddress, type MailConfig } from "./config.ts";

export type Folder = Pick<ListResponse, "path" | "specialUse" | "flags" | "specialUseSource" | "status">;
export interface MailConnection {
  capabilities: Map<string, unknown>;
  connect(): Promise<void>;
  close(): void;
  on(event: "close" | "error" | "exists", listener: () => void): unknown;
  off(event: "close" | "exists", listener: () => void): unknown;
  options?: Pick<ImapFlowOptions, "host">;
  list(options?: ListOptions): Promise<Folder[]>;
  // 163 omits UIDNEXT from SELECT, so uidNext can be missing at runtime despite the imapflow type.
  mailboxOpen(path: string, options: { readOnly: boolean }): Promise<Pick<MailboxObject, "uidValidity"> & { uidNext?: number; exists?: number }>;
  search(query: SearchObject, options: { uid: true; strict: true }): Promise<number[] | false | undefined>;
  fetchAll(ids: number[], query: FetchQueryObject, options: { uid: true }): Promise<FetchMessageObject[]>;
  fetchOne(uid: number, query: FetchQueryObject, options: { uid: true }): Promise<FetchMessageObject | false>;
  download(uid: number, part: string, options: DownloadOptions): Promise<DownloadObject | DownloadNotFound>;
  messageFlagsAdd(ids: number[], flags: string[], options: { uid: true }): Promise<boolean>;
  messageFlagsRemove(ids: number[], flags: string[], options: { uid: true }): Promise<boolean>;
  messageMove(ids: number[], destination: string, options: { uid: true }): Promise<object | false>;
  append(path: string, raw: Buffer, flags: string[]): Promise<object | false>;
}
export type Message = { to: string | string[]; cc?: string[]; subject: string; text: string;
  inReplyTo?: string; references?: string[]; attachments?: { filename: string; contentType: string; content: Buffer }[] };
export type MailClients = {
  imap(options: ImapFlowOptions): MailConnection;
  smtp(config: MailConfig, to: string | string[], raw: Buffer): Promise<void>;
};
export function smtpTransport(config: MailConfig, checking = false) {
  return createTransport({
    ...(checking && { connectionTimeout: 12_000, greetingTimeout: 12_000, socketTimeout: 12_000 }),
    ...config.smtp, secure: config.smtp.port === 465 || config.smtp.port === 994, requireTLS: true,
    auth: { user: config.address, pass: config.authCode },
  });
}

export const defaultClients: MailClients = {
  imap: options => new ImapFlow(options),
  async smtp(config, to, raw) {
    const transport = smtpTransport(config);
    try {
      const result = await transport.sendMail({ envelope: { from: config.address, to: Array.isArray(to) ? to : [to] }, raw });
      if (result.rejected.length) throw new Error("SMTP rejected some recipients");
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
  const fallback = kind === "Sent" ? "已发送" : "草稿箱";
  return special?.path ?? folders.find(folder => folder.path === fallback)?.path ??
    folders.find(folder => folder.specialUse?.toLowerCase() === flag.toLowerCase())?.path ?? fallback;
}

export async function uids(client: MailConnection, query: SearchObject) {
  const result = await client.search(query, { uid: true, strict: true });
  if (!Array.isArray(result)) throw new Error("Incomplete IMAP SEARCH response");
  return result;
}

export function compose(config: MailConfig, message: Message, messageId?: string, date?: Date) {
  const recipients = [message.to, message.cc ?? []].flat();
  if (!recipients.length || !recipients.every(validAddress)) throw new Error("Expected valid recipient email addresses");
  const boundary = messageId && createHash("sha256").update(messageId).digest("hex").slice(0, 24);
  return new MailComposer({ ...message, ...(boundary && { baseBoundary: boundary }), from: config.address, messageId, date, newline: "win" }).compile().build();
}

export async function append(client: MailConnection, path: string, raw: Buffer, flags: string[]) {
  if (!await client.append(path, raw, flags)) throw new Error("IMAP APPEND failed");
}
