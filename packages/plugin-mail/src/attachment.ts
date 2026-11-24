import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { MailConnection } from "./client.ts";
import { parts, selectedMessage } from "./read.ts";

export async function attachmentStream(client: MailConnection, uid: number, part: string) {
  const { content } = await client.download(uid, part, { uid: true, decodeText: false });
  if (!content) throw new Error(`Missing attachment part ${part} for UID ${uid}`);
  return content;
}

export async function saveAttachment(client: MailConnection, dataDir: string, account: string, folder: string, uid: number, index: number) {
  const box = await client.mailboxOpen(folder, { readOnly: true });
  const msg = await selectedMessage(client, uid);
  const item = parts(msg.bodyStructure).attachments[index - 1];
  if (!item) throw new Error(`No attachment ${index} for UID ${uid}`);
  const dir = resolve(dataDir, "attachments");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await lstat(dir)).isDirectory()) throw new Error("Invalid attachments directory");
  const base = basename(item.filename.replaceAll("\\", "/")).replace(/[^\p{L}\p{N}_.-]/gu, "_").replace(/^\.+|\.+$/g, "");
  const name = [...base].slice(-50).join("") || "attachment";
  const key = createHash("sha256").update(JSON.stringify([account, folder, String(box.uidValidity), uid, index])).digest("hex").slice(0, 24);
  const path = resolve(dir, key + "-" + name);
  const temporary = resolve(dir, randomUUID() + ".tmp");
  const content = await attachmentStream(client, uid, item.part);
  const file = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  try {
    await pipeline(content, file);
    await rename(temporary, path);
    return { path, type: item.type, size: file.bytesWritten };
  } finally { await rm(temporary, { force: true }); }
}
