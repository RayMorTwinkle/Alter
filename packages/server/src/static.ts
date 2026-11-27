import { readFile, realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// Inspect the raw request target before URL normalization can erase traversal segments.
export function requestPath(target: string) {
  let path: string;
  try { path = decodeURIComponent(target.split("?", 1)[0]!); }
  catch { throw new HttpError(400, "Invalid URL encoding"); }
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\x00-\x1f]/.test(path) || path.split("/").includes("..")) {
    throw new HttpError(400, "Invalid request path");
  }
  return path;
}

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".map": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".ps1": "text/plain; charset=utf-8", ".sh": "text/plain; charset=utf-8",
};

export async function serveStatic(dist: string, path: string, res: ServerResponse) {
  try {
    const root = await realpath(dist);
    async function file(name: string) {
      const full = await realpath(resolve(root, "." + name));
      const rel = relative(root, full);
      if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new HttpError(403, "Outside web directory");
      return (await stat(full)).isFile() ? full : undefined;
    }
    let asset: string | undefined;
    try { asset = await file(path); }
    catch (error) { if (!missing(error)) throw error; }
    asset ??= await file("/index.html");
    if (!asset) throw new HttpError(404, "Web build not found");
    const bytes = await readFile(asset);
    res.writeHead(200, { "Content-Type": mime[extname(asset).toLowerCase()] ?? "application/octet-stream" }).end(bytes);
  } catch (error) {
    if (missing(error)) throw new HttpError(404, "Web build not found");
    throw error;
  }
}

function missing(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
