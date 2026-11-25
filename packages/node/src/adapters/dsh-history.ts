import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import type { NativeSession } from "@alter/node-protocol";

// dsh-session-persistence-jsonl escapes UTF-16 code units and bounds the project key.
function escapeSegment(s: string) {
  return s.replace(/[^A-Za-z0-9._-]|^(?:\.{1,2})$/g, chars =>
    Array.from(chars, c => "~" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")).join(""));
}
export function dshLog(session: NativeSession, root = path.join(homedir(), ".dsh", "sessions")) {
  const key = escapeSegment(session.cwd.replace(/[/:\\]+/g, "-")).replace(/^-+/, "") || "root";
  return path.join(root, "--" + key.slice(0, 251) + "--", escapeSegment(session.sessionId), "session.v3.jsonl.zstd");
}

export async function logTime(file: string) {
  try {
    const info = await stat(file);
    return info.isFile() ? Math.trunc(info.mtimeMs) : undefined;
  } catch { return undefined; }
}

const inflate = promisify(zstdDecompress);

export async function dshTitle(file: string, signal: AbortSignal) {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return;
  try {
    // Node 24 may decode just the first frame of a concatenated zstd input.
    // dsh writes a complete header or batch of JSONL rows in each frame.
    let position = 0, size = 65536, atEnd = false;
    let input: Buffer = Buffer.alloc(0);
    while (!signal.aborted) {
      if (!input.length) {
        const buffer = Buffer.allocUnsafe(size);
        const { bytesRead } = await handle.read(buffer, 0, size, position);
        if (!bytesRead) return;
        atEnd = bytesRead < size;
        input = buffer.subarray(0, bytesRead);
      }
      let frame;
      try {
        frame = await inflate(input, { info: true, maxOutputLength: 32 * 1024 * 1024 }) as unknown as
          { buffer: Buffer; engine: { bytesWritten: number } };
      } catch (err) {
        if (atEnd || (err as NodeJS.ErrnoException).code !== "Z_BUF_ERROR" || size >= 32 * 1024 * 1024) return;
        size *= 2; input = Buffer.alloc(0); continue;
      }
      if (!frame.engine.bytesWritten) return;
      position += frame.engine.bytesWritten;
      input = input.subarray(frame.engine.bytesWritten);
      for (const line of frame.buffer.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (row.type !== "user/message" || (row.data?.source && row.data.source.kind !== "user")) continue;
        const content = row.data?.content;
        const text = typeof content === "string" ? content : content?.filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text).join(" ");
        return text?.replace(/\s+/g, " ").trim().slice(0, 120) || undefined;
      }
    }
  } catch { /* Older formats and incomplete logs still have usable session IDs. */ }
  finally { await handle.close(); }
}
