import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  answerUserPermission, context, funnel, observeSurface, readTranscript, stopMainTurn, submitMessage, updateNotification,
  MemoryInputError, schema, Tasks, usageSummary, type AlterApp,
} from "@alter/core";
import type { FeishuAccount, FeishuPairing } from "@alter/plugin-feishu";
import { HttpError, requestPath, serveStatic } from "./static.ts";

const cookieName = "alter_session";
const cookieOptions = "Path=/; HttpOnly; SameSite=Strict";
const sessionMs = 365 * 24 * 3600_000;
const defaultDist = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const digest = (value: string) => createHash("sha256").update(value).digest();

const notificationPatch = schema.compile(schema.obj({
  status: schema.opt(schema.lit("read")), feedback: schema.opt(schema.oneOf(["useful", "useless"])),
}));

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

type WebOptions = {
  password: string; dataDir: string; dist?: string; calendar?: Agenda;
  feishu?: { pairing(): FeishuPairing }; feishuAccount?: FeishuAccount;
};

export async function createWebServer(app: AlterApp, options: WebOptions) {
  if (!options.password) throw new Error("Missing ALTER_WEB_PASSWORD");
  const passwordHash = digest(options.password);
  const sessions = openSessions(join(options.dataDir, "web-sessions.json"), passwordHash);
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
  const { calendar, feishuAccount } = options;
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
    if (method === "GET" && path === "/api/feishu/oauth/callback") {
      res.setHeader("Referrer-Policy", "no-referrer");
      if (!feishuAccount) throw new HttpError(404, "Feishu is not configured");
      const params = new URL(req.url!, "http://localhost").searchParams;
      const states = params.getAll("state");
      const codes = params.getAll("code");
      let message = "授权请求无效或已过期，请从 Web 设置重新连接。";
      let status = 400;
      try {
        if (await feishuAccount.callback(states.length === 1 ? states[0]! : null, codes.length === 1 ? codes[0]! : null)) {
          res.writeHead(302, { Location: "/" }).end();
          return;
        }
      } catch (error) {
        // SDK token errors carry only status, code and description, never the secret or tokens.
        const { name, message: detail, code, statusCode: http } = error as Error & { code?: unknown; statusCode?: unknown };
        console.error("Feishu OAuth callback failed:", name, http ?? "", code ?? "", detail);
        status = 502;
        message = "飞书账号连接失败，请检查应用权限和回调地址后重试。";
      }
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><meta charset="utf-8"><title>飞书授权失败</title><p>${message}</p><a href="/">返回 Alter</a>`);
      return;
    }
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
      res.setHeader("Set-Cookie", `${cookieName}=${session}; Max-Age=${sessionMs / 1000}; ${cookieOptions}`);
    } else if (logout) {
      if (token) sessions.delete(token);
      for (const [client, owner] of clients) if (owner === token) { clients.delete(client); client.end(); }
      res.setHeader("Set-Cookie", `${cookieName}=; Max-Age=0; ${cookieOptions}`);
    } else if (method === "GET" && path === "/api/state") {
      return json(res, 200, surface.snapshot());
    } else if (method === "GET" && path === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
      clients.set(res, token!);
      const stopMemory = app.memory.subscribe(items => {
        if (clients.has(res)) write(res, frame("memory", items));
      });
      res.on("close", () => { clients.delete(res); stopMemory(); });
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
    } else if (method === "POST" && /^\/api\/notifications\/[^/]+$/.test(path)) {
      const patch = await body(req);
      if (!notificationPatch.check(patch) || !Object.keys(patch).length) throw new HttpError(400, "Expected read status or useful/useless feedback");
      if (!await updateNotification(app.main, path.split("/")[3]!, patch)) throw new HttpError(404, "Unknown notification");
    } else if (method === "GET" && path === "/api/memory") {
      return json(res, 200, app.memory.list());
    } else if ((method === "PATCH" || method === "DELETE") && /^\/api\/memory\/[^/]+$/.test(path)) {
      const id = path.split("/")[3]!;
      const found = method === "PATCH" ? app.memory.update(id, await body(req)) : app.memory.delete(id);
      if (!found) throw new HttpError(404, "Unknown memory");
    } else if (method === "GET" && path === "/api/calendar" && calendar) {
      return json(res, 200, agenda());
    } else if (method === "GET" && path === "/api/feishu" && options.feishu) {
      return json(res, 200, { ...options.feishu.pairing(), account: await feishuAccount?.status() ?? { connected: false } });
    } else if (method === "GET" && path === "/api/feishu/oauth/start" && feishuAccount) {
      res.writeHead(302, { Location: feishuAccount.start() }).end();
      return;
    } else if (method === "POST" && path === "/api/feishu/account/disconnect" && feishuAccount) {
      await feishuAccount.disconnect();
    } else if (method === "GET" && path === "/api/funnel") {
      const values = new URL(req.url!, "http://localhost").searchParams.getAll("days");
      const days = Number(values[0] ?? 7);
      if (values.length > 1 || !/^\d+$/.test(values[0] ?? "7") || !Number.isSafeInteger(days) || days < 1 || days > 366) {
        throw new HttpError(400, "days must be an integer between 1 and 366");
      }
      return json(res, 200, funnel(surface.snapshot().notifications, app.timeZone, days, { at: app.now(), feishu: !!options.feishu }));
    } else if (method === "GET" && path === "/api/usage") {
      return json(res, 200, await usageSummary(options.dataDir));
    } else throw new HttpError(404, "Unknown endpoint");
    res.writeHead(204).end();
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((cause: unknown) => {
      const error = cause instanceof MemoryInputError ? new HttpError(400, cause.message) : cause;
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

// Sessions survive restarts for a year. Only token hashes are stored, and a new password invalidates them all.
function openSessions(path: string, passwordHash: Buffer) {
  const key = (token: string) => digest(token).toString("hex");
  const owner = passwordHash.toString("hex");
  let saved: Record<string, number> = {};
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as { owner?: string; sessions?: Record<string, number> };
    if (file.owner === owner && file.sessions) saved = file.sessions;
  } catch { /* First start or unreadable file: everyone logs in again. */ }
  function persist() {
    const now = Date.now();
    for (const [k, expires] of Object.entries(saved)) if (expires <= now) delete saved[k];
    const temp = `${path}.${randomBytes(6).toString("hex")}`;
    writeFileSync(temp, JSON.stringify({ owner, sessions: saved }), { mode: 0o600 });
    renameSync(temp, path);
  }
  return {
    has: (token: string) => (saved[key(token)] ?? 0) > Date.now(),
    add(token: string) { saved[key(token)] = Date.now() + sessionMs; persist(); },
    delete(token: string) { delete saved[key(token)]; persist(); },
  };
}

