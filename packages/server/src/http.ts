import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./static.ts";

export function readCookie(req: IncomingMessage, name: string) {
  return req.headers.cookie?.split(";").map(c => c.trim()).find(c => c.startsWith(name + "="))?.slice(name.length + 1);
}

export function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(data));
}

export async function body(req: IncomingMessage, optional = false): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 1024 * 1024) { req.resume(); throw new HttpError(413, "Request too large"); }
    chunks.push(chunk);
  }
  if (optional && !length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* Invalid JSON uses the same error as an invalid top-level value. */ }
  throw new HttpError(400, "Expected a JSON object");
}

export function requestOrigin(req: IncomingMessage) {
  const protocol = "encrypted" in req.socket && req.socket.encrypted ? "https" : "http";
  const host = req.headers.host;
  if (!host || !/^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/.test(host)) throw new HttpError(400, "Invalid Host");
  return protocol + "://" + host;
}
