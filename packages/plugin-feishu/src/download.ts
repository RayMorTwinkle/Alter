import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

function filename(disposition: string, fallback: string) {
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)?.[1];
  let name = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition)?.slice(1).find(Boolean) ?? fallback;
  if (encoded) {
    try { name = decodeURIComponent(encoded.trim()); } catch { /* Use the ordinary filename. */ }
  }
  const basename = name.split(/[\\/]/).at(-1) ?? "";
  return Array.from(basename.replace(/[<>:"|?*\p{C}]/gu, "_").replace(/^[. ]+|[. ]+$/g, "")).slice(0, 48).join("") || "resource";
}

export async function saveResource(dataDir: string, key: string, type: "file" | "image",
  resource: { stream: Readable; disposition: string; mime?: string }) {
  const dir = resolve(dataDir, "downloads");
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!(await lstat(dir)).isDirectory()) throw new Error("飞书下载目录必须是本地目录");
    const path = resolve(dir, randomUUID() + "-" + filename(resource.disposition, key));
    const file = await open(path, "wx", 0o600);
    try {
      const output = file.createWriteStream();
      await pipeline(resource.stream, output);
      // Feishu can send a JSON error envelope with HTTP 200. JSON attachments are valid files too.
      if (!resource.disposition && resource.mime?.includes("application/json") && output.bytesWritten <= 64 * 1024) {
        const body = await readFile(path, "utf8");
        let envelope;
        try { envelope = JSON.parse(body); } catch { /* Keep the downloaded file verbatim. */ }
        if (typeof envelope?.code === "number" && envelope.code !== 0 && typeof envelope.msg === "string") {
          throw new Error(`Feishu messageResource.get failed (${envelope.code})`);
        }
      }
      return { path, type, mime: resource.mime, size: output.bytesWritten };
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    } finally { await file.close(); }
  } finally { resource.stream.destroy(); }
}
