import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import {
  answerUserPermission, context, observeSurface, readTranscript, stopMainTurn, submitMessage,
  Tasks, usageSummary, type AlterApp,
} from "@alter/core";
import type { FeishuPairing } from "@alter/plugin-feishu";
import { HttpError, requestPath, serveStatic } from "./static.ts";

const cookieName = "alter_session";
const cookieOptions = "Path=/; HttpOnly; SameSite=Strict";
const defaultDist = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const digest = (value: string) => createHash("sha256").update(value).digest();

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(data));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 1024 * 1024) { req.resume(); throw new HttpError(413, "Request too large"); }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* Invalid JSON uses the same error as an invalid top-level value. */ }
  throw new HttpError(400, "Expected a JSON object");
}

// Structural so the server does not depend on a calendar implementation.
export type Agenda = { timeZone: string; agenda(): unknown[]; subscribe(listener: () => void): () => void };

export async function createWebServer(app: AlterApp, options: { password: string; dataDir: string; dist?: string; calendar?: Agenda; feishu?: { pairing(): FeishuPairing } }) {
  if (!options.password) throw new Error("Missing ALTER_WEB_PASSWORD");
  const passwordHash = digest(options.password);
  const sessions = new Set<string>();
  const clients = new Map<ServerResponse, string>();
  function write(res: ServerResponse, frame: string) {
    // A disconnected or stalled client can rebuild from a snapshot on reconnect.
    if (res.destroyed || res.writableLength > 1024 * 1024) { clients.delete(res); res.destroy(); return; }
    res.write(frame);
  }
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const surface = await observeSurface(app, ({ event, data }) => {
    if (!clients.size) return;
    const message = frame(event, data);
    for (const res of clients.keys()) write(res, message);
  });
  const { calendar } = options;
  const agenda = () => ({ timeZone: calendar!.timeZone, events: calendar!.agenda() });
  const unsubscribe = calendar?.subscribe(() => {
    if (!clients.size) return;
    const message = frame("calendar", agenda());
    for (const res of clients.keys()) write(res, message);
  });
  const heartbeat = setInterval(() => {
    for (const res of clients.keys()) write(res, ": ping\n\n");
  }, 20_000).unref();

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    const path = requestPath(req.url ?? "/");
    const method = req.method;
    if (path !== "/api" && !path.startsWith("/api/")) {
      if (method !== "GET") throw new HttpError(405, "Method not allowed");
      return serveStatic(options.dist ?? defaultDist, path, res);
    }
    res.setHeader("Cache-Control", "no-store");
    const token = req.headers.cookie?.split(";").map(c => c.trim()).find(c => c.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
    const login = method === "POST" && path === "/api/login";
    const logout = method === "POST" && path === "/api/logout";
    if (!login && !logout && !(token && sessions.has(token))) throw new HttpError(401, "Login required");
    if (method !== "GET" && method !== "HEAD" && req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw new HttpError(415, "Content-Type must be application/json");
    }
    if (login) {
      const { password } = await body(req);
      if (typeof password !== "string" || !timingSafeEqual(digest(password), passwordHash)) throw new HttpError(401, "Invalid password");
      const session = randomBytes(32).toString("base64url");
      sessions.add(session);
      res.setHeader("Set-Cookie", `${cookieName}=${session}; ${cookieOptions}`);
    } else if (logout) {
      if (token) sessions.delete(token);
      for (const [client, owner] of clients) if (owner === token) { clients.delete(client); client.end(); }
      res.setHeader("Set-Cookie", `${cookieName}=; Max-Age=0; ${cookieOptions}`);
    } else if (method === "GET" && path === "/api/state") {
      return json(res, 200, surface.snapshot());
    } else if (method === "GET" && path === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
      clients.set(res, token!);
      res.on("close", () => clients.delete(res));
      write(res, frame("snapshot", surface.snapshot()));
      if (surface.partial) write(res, frame("delta", surface.partial));
      return;
    } else if (method === "POST" && path === "/api/messages") {
      const { text } = await body(req);
      if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Expected non-empty text");
      return json(res, 202, { id: await submitMessage(app.main, text) });
    } else if (method === "POST" && /^\/api\/permissions\/[^/]+$/.test(path)) {
      const { allow, note } = await body(req);
      if (typeof allow !== "boolean" || (note !== undefined && typeof note !== "string")) throw new HttpError(400, "Expected boolean allow and optional string note");
      const answer = await answerUserPermission(app.main, { requestId: path.split("/")[3]!, allow, note });
      // The broker treats a duplicate signal as an idempotent success. HTTP distinguishes it from a first decision.
      if (answer.isError || answer.output[0]?.text !== "delivered") throw new HttpError(409, "No pending user decision");
    } else if (method === "GET" && /^\/api\/tasks\/[^/]+\/transcript$/.test(path)) {
      const tasks = await app.harness.snapshot(Tasks, app.main.id, context);
      const id = path.split("/")[3]!;
      if (!tasks || !Object.hasOwn(tasks.byId, id)) throw new HttpError(404, "Unknown task");
      const conversation = await app.harness.conversation(tasks.byId[id]!.conversationId, context);
      if (!conversation) throw new HttpError(404, "Unknown conversation");
      return json(res, 200, { items: await readTranscript(conversation) });
    } else if (method === "POST" && path === "/api/stop") {
      await stopMainTurn(app);
    } else if (method === "GET" && path === "/api/calendar" && calendar) {
      return json(res, 200, agenda());
    } else if (method === "GET" && path === "/api/feishu" && options.feishu) {
      return json(res, 200, options.feishu.pairing());
    } else if (method === "GET" && path === "/api/usage") {
      return json(res, 200, await usageSummary(options.dataDir));
    } else throw new HttpError(404, "Unknown endpoint");
    res.writeHead(204).end();
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!(error instanceof HttpError)) console.error("Alter web request failed", error);
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof HttpError) json(res, error.status, { error: error.message });
      else json(res, 500, { error: "Internal server error" });
    });
  });
  function dispose() {
    clearInterval(heartbeat);
    unsubscribe?.();
    surface.detach();
    sessions.clear();
    for (const res of clients.keys()) res.end();
    clients.clear();
  }
  server.once("close", dispose);
  return { server, async close() {
    dispose();
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  } };
}
