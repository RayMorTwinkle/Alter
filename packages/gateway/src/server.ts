import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import { connectPath, parseNodeToken } from "@alter/node-protocol";
import { body, json, readCookie } from "../../server/src/http.ts";
import { repoRoot } from "../../server/src/gateway-trust.ts";
import { HttpError, requestPath, serveStatic } from "../../server/src/static.ts";
import { identity, loginLimiter, sessionLifetime, type Accounts } from "./accounts.ts";
import type { Instances } from "./instances.ts";
import { failUpgrade, proxyHttp, proxyUpgrade } from "./proxy.ts";

const cookieName = (req: IncomingMessage) => "alter_gw_" + req.socket.localPort;
function cookie(req: IncomingMessage, token: string) {
  return `${cookieName(req)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? sessionLifetime / 1000 : 0}` +
    (req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "");
}
function clientIp(req: IncomingMessage) {
  const peer = req.socket.remoteAddress ?? "";
  const forwarded = req.headers["x-real-ip"];
  if (["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(peer) && typeof forwarded === "string" && isIP(forwarded)) return forwarded;
  return peer;
}

export function gatewayServer(accounts: Accounts, instances: Instances, dist = join(repoRoot, "packages/web/dist")) {
  const limit = loginLimiter();
  const streams = new Set<{ id: string; token: string; stream: ServerResponse | Duplex }>();
  function track(id: string, token: string, stream: ServerResponse | Duplex) {
    const entry = { id, token, stream };
    streams.add(entry);
    stream.once("close", () => streams.delete(entry));
  }
  function disconnect(id?: string, token?: string) {
    for (const entry of streams) {
      if ((!id || entry.id === id) && (!token || entry.token === token)) entry.stream.destroy();
    }
  }
  function errorStatus(error: unknown) {
    if (error instanceof HttpError) return error;
    console.error("Gateway request failed", error);
    return new HttpError(500, "Internal server error");
  }
  const session = (req: IncomingMessage) => readCookie(req, cookieName(req)) ?? "";
  const current = (token: string) => token ? accounts.sessionUser(token) : undefined;

  function route(req: IncomingMessage, path: string) {
    if (path !== connectPath) {
      const token = session(req);
      return { user: current(token), token };
    }
    const bearer = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? "");
    const node = bearer && parseNodeToken(bearer[1]!);
    const user = node ? accounts.find(node.userId) : undefined;
    if (!user || user.disabled) throw new HttpError(401, "Unauthorized node");
    return { user, token: "" };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = requestPath(req.url ?? "/"), method = req.method, token = session(req);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (path !== "/gateway" && !path.startsWith("/gateway/")) {
      const { user, token } = route(req, path);
      if (user) {
        track(user.id, token, res);
        return proxyHttp(req, res, user, await instances.ready(user));
      }
      if (path === "/api" || path.startsWith("/api/")) throw new HttpError(401, "Login required");
      if (method !== "GET") throw new HttpError(405, "Method not allowed");
      return serveStatic(dist, path, res);
    }
    res.setHeader("Cache-Control", "no-store");
    if (path.startsWith("/gateway/admin/")) accounts.checkAdmin(token);
    if (method !== "GET" && req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw new HttpError(415, "Content-Type must be application/json");
    }
    if (path === "/gateway/register" && method === "POST") {
      return json(res, 201, identity(await accounts.register(await body(req))));
    }
    if (path === "/gateway/login" && method === "POST") {
      const { username, password } = await body(req);
      if (typeof username !== "string" || typeof password !== "string") throw new HttpError(400, "Expected username and password");
      const success = limit(username, clientIp(req));
      const result = await accounts.login(username, password);
      success();
      instances.start(result.user);
      res.setHeader("Set-Cookie", cookie(req, result.token));
      return json(res, 200, identity(result.user));
    }
    if (path === "/gateway/logout" && method === "POST") {
      if (token) { accounts.logout(token); disconnect(undefined, token); }
      res.setHeader("Set-Cookie", cookie(req, ""));
      return res.writeHead(204).end();
    }
    if (path === "/gateway/me" && method === "GET") {
      const user = current(token);
      if (!user) throw new HttpError(401, "Login required");
      return json(res, 200, identity(user));
    }
    if (path === "/gateway/admin/users" && method === "GET") {
      return json(res, 200, await Promise.all(accounts.users().map(async u => ({ ...u, instance: await instances.info(u) }))));
    }
    const match = /^\/gateway\/admin\/users\/([^/]+)(\/restart)?$/.exec(path);
    if (match && !match[2] && method === "PATCH") {
      const user = await accounts.patch(token, match[1]!, await body(req));
      disconnect(user.id);
      if (user.disabled) await instances.stop(user.id);
      return json(res, 200, { ...user, instance: await instances.info(user) });
    }
    if (match?.[2] && method === "POST") {
      const user = accounts.find(match[1]!);
      if (!user) throw new HttpError(404, "Unknown user");
      if (!user.port || user.disabled) throw new HttpError(409, "Instance cannot be restarted");
      await instances.stop(user.id);
      accounts.checkAdmin(token);
      await instances.ready(accounts.find(user.id)!);
      return res.writeHead(204).end();
    }
    if (path === "/gateway/admin/invites") {
      if (method === "GET") return json(res, 200, accounts.invites());
      if (method === "POST") {
        const { days } = await body(req, true);
        return json(res, 201, accounts.invite(accounts.checkAdmin(token).id, days));
      }
    }
    if (/^\/gateway\/admin\/invites\/[^/]+$/.test(path) && method === "DELETE") {
      accounts.revoke(path.split("/").at(-1)!);
      return res.writeHead(204).end();
    }
    throw new HttpError(404, "Unknown endpoint");
  }
  const pending = new Set<Promise<void>>();
  function watch(work: Promise<void>) {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }
  const server = createServer((req, res) => {
    watch(handle(req, res).then(() => {}, error => {
      const { status, message } = errorStatus(error);
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) json(res, status, { error: message });
    }));
  });
  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (req.method !== "GET" || req.headers.upgrade?.toLowerCase() !== "websocket") throw new HttpError(400, "Expected WebSocket upgrade");
    const path = requestPath(req.url ?? "/");
    if (path === "/gateway" || path.startsWith("/gateway/")) throw new HttpError(404, "Unknown endpoint");
    if (path !== connectPath && req.headers.origin && (!URL.canParse(req.headers.origin) ||
        new URL(req.headers.origin).host !== req.headers.host)) throw new HttpError(403, "Cross-origin upgrade");
    const { user, token } = route(req, path);
    if (!user) throw new HttpError(401, "Login required");
    track(user.id, token, socket);
    proxyUpgrade(req, socket, head, user, await instances.ready(user));
  }
  const sockets = new Set<Duplex>();
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    watch(upgrade(req, socket, head).catch(error => failUpgrade(socket, errorStatus(error).status)));
  });
  return { server, async close() {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await Promise.all([closed, instances.close()]);
    await Promise.allSettled(pending);
  } };
}
