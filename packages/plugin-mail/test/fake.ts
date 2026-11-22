import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { FetchMessageObject, SearchObject } from "imapflow";
import { vi } from "vitest";
import type { MailClients, MailConfig, MailConnection } from "../src/index.ts";

export const config: MailConfig = {
  address: "me@example.test", authCode: "offline", imap: { host: "imap.invalid", port: 993 },
  smtp: { host: "smtp.invalid", port: 465 },
};
export const outgoing = { to: "reader@example.test", subject: "你好", text: "A note" };
export function fakeMail() {
  const inbox = new Map<number, FetchMessageObject>();
  const sent = new Map<string, Buffer>();
  const parts = new Map<string, Buffer>();
  const folders = [{ path: "custom/sent", flags: new Set(["\\Sent"]) }, { path: "custom/drafts", flags: new Set(["\\Drafts"]) }];
  class Session extends EventEmitter implements MailConnection {
    selected = "";
    connect = vi.fn(async () => {});
    close = vi.fn(() => { this.emit("close"); });
    list = vi.fn(async () => folders);
    mailboxOpen = vi.fn(async (path: string) => {
      this.selected = path;
      return { uidValidity: 11n, uidNext: Math.max(0, ...inbox.keys()) + 1 };
    });
    search = vi.fn(async (query: SearchObject): Promise<number[] | false> => {
      if (query.header) return sent.has(String(query.header["Message-ID"])) ? [1] : [];
      return [...inbox.keys()].sort((a, b) => a - b);
    });
    fetchAll = vi.fn(async (ids: number[]) => ids.map(id => inbox.get(id)!));
    fetchOne = vi.fn(async (id: number) => inbox.get(id) ?? false as const);
    download = vi.fn(async (_uid: number, part: string) => {
      const bytes = parts.get(part);
      if (!bytes) throw new Error("Unexpected body download " + part);
      return { meta: {}, content: Readable.from([bytes]) };
    });
    append = vi.fn(async (path: string, raw: Buffer, _flags: string[]) => {
      if (path === "custom/sent" || path === "已发送") sent.set(messageId(raw), raw);
      return {};
    });
  }
  const sessions: Session[] = [];
  const clients = {
    imap: vi.fn(() => { const session = new Session(); sessions.push(session); return session; }),
    smtp: vi.fn(async (_config: MailConfig, _to: string, _raw: Buffer) => {}),
  } satisfies MailClients;
  return { inbox, sent, parts, folders, clients, sessions };
}
export function messageId(raw: Buffer) {
  return /^Message-ID: (.+)\r$/im.exec(raw.toString())![1]!;
}
