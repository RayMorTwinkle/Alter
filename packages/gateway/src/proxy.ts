import { request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { User } from "./accounts.ts";
import type { Target } from "./instances.ts";
import { json } from "../../server/src/http.ts";

function endToEnd(input: IncomingHttpHeaders) {
  const headers = { ...input };
  const connection = input.connection?.split(",").map(s => s.trim().toLowerCase()) ?? [];
  for (const key of [...connection, "connection", "upgrade", "proxy-connection", "keep-alive", "transfer-encoding",
    "te", "trailer", "proxy-authorization", "proxy-authenticate", "x-alter-gateway-secret", "x-alter-user", "x-alter-username"]) delete headers[key];
  return headers;
}

function upstream(req: IncomingMessage, user: User, target: Target, upgrade = false) {
  const headers = endToEnd(req.headers);
  if (headers.cookie) {
    headers.cookie = headers.cookie.split(";").map(s => s.trim()).filter(s => !/^(?:alter_gw_\d+|alter_session(?:_\d+)?)=/.test(s)).join("; ");
    if (!headers.cookie) delete headers.cookie;
  }
  headers["x-alter-gateway-secret"] = target.secret;
  headers["x-alter-user"] = user.id;
  headers["x-alter-username"] = user.username;
  if (upgrade) { headers.connection = "Upgrade"; headers.upgrade = "websocket"; }
  return request({ hostname: "127.0.0.1", port: target.port, method: req.method, path: req.url, headers, agent: false });
}

export function proxyHttp(req: IncomingMessage, res: ServerResponse, user: User, target: Target) {
  if (res.destroyed) return;
  const outgoing = upstream(req, user, target);
  res.once("close", () => outgoing.destroy());
  outgoing.on("error", () => {
    if (res.headersSent) res.destroy();
    else if (!res.destroyed) json(res, 502, { error: "Instance unavailable" });
  });
  outgoing.on("response", reply => {
    res.writeHead(reply.statusCode!, endToEnd(reply.headers));
    res.flushHeaders();
    reply.on("error", () => res.destroy());
    reply.pipe(res);
  });
  req.on("error", () => outgoing.destroy());
  req.pipe(outgoing);
}

export function failUpgrade(socket: Duplex, status: number) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, user: User, target: Target) {
  if (socket.destroyed) return;
  const outgoing = upstream(req, user, target, true);
  socket.once("close", () => outgoing.destroy());
  outgoing.on("error", () => failUpgrade(socket, 502));
  outgoing.on("response", reply => { reply.resume(); failUpgrade(socket, reply.statusCode!); });
  outgoing.on("upgrade", (reply, remote, remainder) => {
    if (socket.destroyed) { remote.destroy(); return; }
    remote.on("error", () => socket.destroy());
    remote.once("close", () => socket.destroy());
    socket.once("close", () => remote.destroy());
    const headers = endToEnd(reply.headers);
    const lines = ["HTTP/1.1 101 Switching Protocols", "Connection: Upgrade", "Upgrade: websocket"];
    for (const [key, value] of Object.entries(headers)) {
      for (const item of Array.isArray(value) ? value : [value]) lines.push(key + ": " + item);
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (remainder.length) socket.write(remainder);
    if (head.length) remote.write(head);
    socket.pipe(remote).pipe(socket);
  });
  outgoing.end();
}
