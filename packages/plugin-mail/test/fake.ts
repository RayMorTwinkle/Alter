import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { FetchMessageObject, SearchObject, ImapFlowOptions, ListOptions } from "imapflow";
import { simpleParser } from "mailparser";
import { vi } from "vitest";
import { context, type ToolRegistration } from "@alter/core";
import { createMailPlugin, type MailClients, type MailConfig, type MailConnection } from "../src/index.ts";
import type { Folder } from "../src/client.ts";

export const config: MailConfig = {
  address: "me@example.test", authCode: "offline", imap: { host: "imap.invalid", port: 993 },
  smtp: { host: "smtp.invalid", port: 465 },
};
export const outgoing = { to: "reader@example.test", subject: "你好", text: "A note" };
export function fakeMail() {
  const inbox = new Map<number, FetchMessageObject>();
  const sent = new Map<string, Buffer>();
  const parts = new Map<string, Buffer>();
  const folders: Folder[] = [{ path: "INBOX", flags: new Set() }, { path: "custom/sent", flags: new Set(["\\Sent"]) },
    { path: "custom/drafts", flags: new Set(["\\Drafts"]) }];
  const boxes = new Map(folders.map(f => [f.path, f.path === "INBOX" ? inbox : new Map<number, FetchMessageObject>()]));
  class Session extends EventEmitter implements MailConnection {
    options?: Pick<ImapFlowOptions, "host">;
    selected = "";
    get box() { return boxes.get(this.selected)!; }
    capabilities = new Map<string, unknown>([["IDLE", true], ["MOVE", true]]);
    connect = vi.fn(async () => {});
    close = vi.fn(() => { this.emit("close"); });
    list = vi.fn(async (options?: ListOptions) => folders.map(f => {
      const rows = [...boxes.get(f.path)?.values() ?? []];
      return options?.statusQuery ? { ...f, status: { path: f.path, messages: rows.length, unseen: rows.filter(r => !r.flags?.has("\\Seen")).length } } : f;
    }));
    mailboxOpen = vi.fn(async (path: string, _options: { readOnly: boolean }): Promise<{ uidValidity: bigint; uidNext?: number; exists?: number }> => {
      if (!boxes.has(path)) throw new Error("Missing folder " + path);
      this.selected = path;
      return { uidValidity: 11n, uidNext: Math.max(0, ...this.box.keys()) + 1, exists: this.box.size };
    });
    search = vi.fn(async (query: SearchObject): Promise<number[] | false> => {
      if (query.header) return this.selected === "custom/sent" && sent.has(String(query.header["Message-ID"])) ? [1] : [];
      const contains = (value: string, needle?: string) => !needle || value.toLowerCase().includes(needle.toLowerCase());
      return [...this.box.values()].filter(row => {
        const e = row.envelope;
        const day = new Date(row.internalDate ?? e?.date ?? 0).getTime();
        const uid = String(query.uid ?? "");
        return (!uid || (uid.endsWith(":*") ? row.uid >= parseInt(uid) : uid.split(",").includes(String(row.uid)))) &&
          (query.seen === undefined || !!row.flags?.has("\\Seen") === query.seen) &&
          (query.flagged === undefined || !!row.flags?.has("\\Flagged") === query.flagged) &&
          (!query.since || day >= new Date(query.since).getTime()) && (!query.before || day < new Date(query.before).getTime()) &&
          contains(JSON.stringify(e?.from ?? []), query.from) && contains(JSON.stringify(e?.to ?? []), query.to) &&
          contains(e?.subject ?? "", query.subject) && contains([e?.subject, parts.get(row.bodyStructure?.part ?? "1")].join(" "), query.text);
      }).map(row => row.uid).sort((a, b) => a - b);
    });
    fetchAll = vi.fn(async (ids: number[]) => ids.flatMap(id => this.box.get(id) ?? []));
    fetchOne = vi.fn(async (id: number) => this.box.get(id) ?? false as const);
    messageFlagsAdd = vi.fn(async (ids: number[], flags: string[]) => {
      for (const id of ids) for (const flag of flags) (this.box.get(id)!.flags ??= new Set()).add(flag);
      return true;
    });
    messageFlagsRemove = vi.fn(async (ids: number[], flags: string[]) => {
      for (const id of ids) for (const flag of flags) this.box.get(id)!.flags?.delete(flag);
      return true;
    });
    messageMove = vi.fn(async (ids: number[], destination: string) => {
      const target = boxes.get(destination);
      if (!target) return false;
      for (const id of ids) {
        const uid = Math.max(0, ...target.keys()) + 1;
        target.set(uid, { ...this.box.get(id)!, uid });
        this.box.delete(id);
      }
      return {};
    });
    download = vi.fn(async (uid: number, part: string) => {
      if (!this.box.has(uid)) throw new Error("Missing UID " + uid);
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
    imap: vi.fn((options?: ImapFlowOptions) => { const session = new Session(); session.options = options; sessions.push(session); return session; }),
    smtp: vi.fn(async (_config: MailConfig, _to: string | string[], _raw: Buffer) => {}),
  } satisfies MailClients;
  async function deliver(raw: Buffer) {
    const mail = await simpleParser(raw);
    const uid = Math.max(0, ...inbox.keys()) + 1;
    const part = String(uid);
    inbox.set(uid, { uid, seq: uid, envelope: { subject: mail.subject },
      bodyStructure: { type: mail.html ? "text/html" : "text/plain", part } });
    parts.set(part, Buffer.from(mail.html || mail.text || ""));
    return mail;
  }
  return { inbox, boxes, sent, parts, folders, clients, sessions, deliver };
}
export function messageId(raw: Buffer) {
  return /^Message-ID: (.+)\r$/im.exec(raw.toString())![1]!;
}

export function setup(overrides: Partial<typeof config> = {}) {
  const fake = fakeMail();
  const plugin = createMailPlugin({ ...config, ...overrides }, fake.clients);
  const docs = { namespace: "", receipts: {} };
  const api = { taskId: 12, conversationId: 2, now: Date.now,
    commit: (fn: (tx: unknown) => unknown) => fn({ doc: async () => docs }) };
  async function call(name: string, args: object) {
    const tool = plugin.tools.find(tool => tool.name === name)!;
    const result = await tool.execute(tool.prepareArguments?.(args) ?? args, api as unknown as Parameters<ToolRegistration["execute"]>[1], context);
    if (!("output" in result)) throw new Error("Missing tool output");
    const first = result.output?.[0];
    if (!first || first.type !== "text") throw new Error("Expected text");
    return { text: first.text, details: result.details };
  }
  return { ...fake, plugin, call, api, docs };
}
