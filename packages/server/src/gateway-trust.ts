import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join, resolve } from "node:path";

export const repoRoot = resolve(import.meta.dirname, "../../..");
export const gatewayDirectory = (env: NodeJS.ProcessEnv) => resolve(repoRoot, env.ALTER_GATEWAY_DATA || "data/gateway");

export function readGatewaySecret(env: NodeJS.ProcessEnv) {
  if (env.ALTER_GATEWAY_SECRET) return env.ALTER_GATEWAY_SECRET;
  try { return readFileSync(join(gatewayDirectory(env), "secret"), "utf8").trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function trustedGateway(req: IncomingMessage) {
  const peer = req.socket.remoteAddress;
  const header = req.headers["x-alter-gateway-secret"];
  if ((peer !== "127.0.0.1" && peer !== "::ffff:127.0.0.1") || typeof header !== "string" || !header) return false;
  const secret = readGatewaySecret(process.env);
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return !!secret && timingSafeEqual(digest(secret), digest(header));
}
