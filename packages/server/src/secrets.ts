import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Entry = { iv: string; tag: string; data: string };
type Value = string | boolean;

export function openSecrets(dir: string) {
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const path = join(dir, "secrets.json");
  const keyPath = join(dir, "secret.key");
  let entries: Record<string, Entry> = {};
  let exists = false;
  try {
    entries = JSON.parse(readFileSync(path, "utf8"));
    exists = true;
    chmodSync(path, 0o600);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let key: Buffer;
  try { key = readFileSync(keyPath); }
  catch (error) {
    if (exists || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temp = keyPath + "." + randomUUID();
    try {
      writeFileSync(temp, randomBytes(32), { mode: 0o600, flag: "wx" });
      try { linkSync(temp, keyPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { rmSync(temp, { force: true }); }
    key = readFileSync(keyPath);
  }
  if (key.length !== 32) throw new Error("Invalid secret.key");
  chmodSync(keyPath, 0o600);
  return {
    get(name: string): Value | undefined {
      const entry = entries[name];
      if (!entry) return;
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"), { authTagLength: 16 });
      decipher.setAAD(Buffer.from(name));
      decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(entry.data, "base64")), decipher.final()]).toString());
    },
    patch(changes: Record<string, Value | null>) {
      const next = { ...entries };
      for (const [name, value] of Object.entries(changes)) {
        if (value === null) { delete next[name]; continue; }
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(Buffer.from(name));
        const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
        next[name] = { iv: iv.toString("base64"), data: data.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
      }
      const temp = path + "." + randomUUID();
      try {
        writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
        renameSync(temp, path);
        entries = next;
      } finally { rmSync(temp, { force: true }); }
    },
  };
}
