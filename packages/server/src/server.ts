import { nodeAdapterRoute } from "./node-adapters.ts";
import { RESTRICTED_HOST_CAPABILITIES, hostPolicy } from "./role-policy.ts";
import { attachNodeSockets } from "./node-sockets.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  AllowedCapabilities, answerUserPermission, approvalStats, parseApprovalDecision, context, funnel, interacted, observeSurface, readTranscript, stopMainTurn, submitMessage, updateNotification,
  validModelOverrides, validHarness, FeedbackError, MemoryConflict, MemoryInputError, NodeSessionsError, schema, stats, subscribeHeartbeat, Tasks, usageSummary, type AlterApp, type Notification, PluginHttpError, type PluginSseFeed,
} from "@alter/core";
import { legacyPluginWeb, type LegacyPluginOptions } from "./legacy-plugin-options.ts";
import { PluginError } from "@alter/plugin-runtime";
import { AdapterError, adapterPresets, presetConfig } from "@alter/adapters";
import type { WebPluginManager } from "./plugins.ts";
import { settingsWriter } from "./settings-api.ts";
import { openService, type ServiceOptions } from "./service.ts";
import { body, json, readCookie, requestOrigin } from "./http.ts";
import { trustedGateway } from "./gateway-trust.ts";
import { HttpError, requestPath, serveStatic } from "./static.ts";

// Cookies ignore ports, so instances sharing a host (production and a smoke run) need their own name.
const legacyCookie = "alter_session";
const cookieFor = (req: IncomingMessage) => `${legacyCookie}_${req.socket.localPort}`;
const cookieOptions = "Path=/; HttpOnly; SameSite=Strict";
const sessionMs = 365 * 24 * 3600_000;
const defaultDist = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const digest = (value: string) => createHash("sha256").update(value).digest();

const notificationPatch = schema.compile(schema.obj({
  status: schema.opt(schema.lit("read")), feedback: schema.opt(schema.oneOf(["useful", "useless"])),
}));

function legacyMemory(req: IncomingMessage) {
  const format = new URL(req.url!, "http://localhost").searchParams.get("memory");
  if (format) return format === "legacy";
  return req.headers["sec-fetch-dest"] === "empty" && req.headers.accept === "*/*";
}

export type { Agenda } from "./legacy-plugin-options.ts";

type WebOptions = LegacyPluginOptions & {
  password: string; dataDir: string; dist?: string; plugins?: WebPluginManager;
  service?: ServiceOptions;
};

export async function createWebServer(app: AlterApp, options: WebOptions) {
  const gatewayMode = process.env.ALTER_AUTH === "gateway";
  const { restricted, allowsRoute } = hostPolicy();
  if (!gatewayMode && !options.password) throw new Error("Missing ALTER_WEB_PASSWORD");
  const passwordHash = digest(options.password);
  const sessions = gatewayMode ? undefined : openSessions(join(options.dataDir, "web-sessions.json"), passwordHash);
  const service = restricted ? undefined : openService(options.dataDir, options.service);
  const clients = new Map<ServerResponse, string>();
  function write(res: ServerResponse, frame: string) {
    // A disconnected or stalled client can rebuild from a snapshot on reconnect.
    if (res.destroyed || res.writableLength > 1024 * 1024) { clients.delete(res); res.destroy(); return; }
    res.write(frame);
  }
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let displayed = new Set<string>();
  let deliveries = Promise.resolve();
  function webDelivery(items: Notification[]) {
    const unread = items.filter(item => item.kind !== "event" && item.level === "now" && item.status === "unread" && item.pushedAt === undefined);
    const fresh = unread.filter(item => !displayed.has(item.id));
    displayed = new Set(unread.map(item => item.id));
    if (fresh.length) deliveries = app.notifications.delivered(fresh.reverse()).catch(error => {
      for (const item of fresh) displayed.delete(item.id);
      console.warn("Web notification receipt failed", error);
    });
  }
  let latestFeedback: Awaited<ReturnType<AlterApp["feedback"]["view"]>>;
  const surface = await observeSurface(app, ({ event, data }) => {
    if (event === "feedback") latestFeedback = data;
    if (!clients.size) return;
    const message = frame(event, data);
    for (const res of clients.keys()) write(res, message);
    if (event === "notifications" && clients.size) webDelivery(data);
  });
  const { plugins } = options;
  const fallback = legacyPluginWeb(options, !plugins, !restricted);
  const extensions = () => [...plugins?.web() ?? [], ...fallback];
  const hasExternalChannel = () => extensions().some(web => web.externalDelivery);
  function broadcast(event: string, data: unknown) {
    const message = frame(event, data);
    for (const res of clients.keys()) write(res, message);
  }
  const feeds = new Map<string, { feed: PluginSseFeed; stop(): void }>();
  function bindFeeds() {
    const next = new Map<string, PluginSseFeed>();
    for (const web of extensions()) for (const feed of web.sse ?? []) {
      if (!next.has(feed.event)) next.set(feed.event, feed);
    }
    for (const [event, binding] of feeds) {
      if (next.get(event) === binding.feed) continue;
      binding.stop();
      feeds.delete(event);
      if (!next.has(event) && clients.size) broadcast(event, binding.feed.cleared ?? null);
    }
    for (const [event, feed] of next) {
      if (feeds.has(event)) continue;
      const publish = () => { if (clients.size && feeds.get(event)?.feed === feed) broadcast(event, feed.snapshot()); };
      feeds.set(event, { feed, stop: feed.subscribe(publish) });
      publish();
    }
  }
  bindFeeds();
  const stopNodeUpdates = app.nodes.adapters.subscribe(() => {
    if (clients.size) void app.nodes.all().then(nodes => broadcast("nodes", nodes)).catch(() => {});
  });
  const stopPlugins = plugins?.subscribe(() => {
    bindFeeds();
    if (clients.size) broadcast("plugins", plugins.list());
  });
  const adapters = plugins?.adapters;
  const ext = plugins?.ext;
  const stopExt = ext?.subscribe(() => {
    if (clients.size) { broadcast("ext-plugins", ext.list()); broadcast("plugins", plugins!.list()); }
  });
  const saveSettings = settingsWriter(app);
  const stopHeartbeat = await subscribeHeartbeat(app.harness, event => {
    const message = frame("heartbeat", event);
    for (const res of clients.keys()) write(res, message);
  });
  const ping = setInterval(() => {
    for (const res of clients.keys()) write(res, ": ping\n\n");
  }, 20_000).unref();

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    const path = requestPath(req.url ?? "/");
    const method = req.method;
    const trusted = trustedGateway(req);
    if (gatewayMode && !trusted) throw new HttpError(401, "Gateway authentication required");
    if (gatewayMode && (path === "/api/login" || path === "/api/logout")) throw new HttpError(404, "Unknown endpoint");
    if (path !== "/api" && !path.startsWith("/api/")) {
      if (method !== "GET") throw new HttpError(405, "Method not allowed");
      return serveStatic(options.dist ?? defaultDist, path, res);
    }
    res.setHeader("Cache-Control", "no-store");
    const route = extensions().flatMap(web => web.routes ?? []).find(r =>
      r.method === method && (typeof r.path === "string" ? r.path === path : r.path.test(path)));
    const activity = () => app.main.commit(tx => interacted(tx, app.now()), context);
    async function mutation(status: number, value?: unknown) {
      await activity();
      if (status === 204) res.writeHead(204).end();
      else json(res, status, value);
    }
    const routeContext = { req, res, path, origin: () => requestOrigin(req), body: () => body(req),
      json: (status: number, data: unknown) => json(res, status, data), mutation };
    if (!restricted && route?.publicCallback && method === "GET" && typeof route.path === "string") {
      return route.handle(routeContext);
    }
    const cookieName = cookieFor(req);
    const current = readCookie(req, cookieName);
    const legacy = current ? undefined : readCookie(req, legacyCookie);
    const token = current ?? legacy;
    const login = method === "POST" && path === "/api/login";
    const logout = method === "POST" && path === "/api/logout";
    if (!login && !logout && !trusted && !(token && sessions?.has(token))) throw new HttpError(401, "Login required");
    // Move a still valid pre-port session to the per-port name without asking for the password again.
    if (legacy && !logout && !trusted && sessions?.has(legacy)) res.setHeader("Set-Cookie", [
      `${cookieName}=${legacy}; Max-Age=${sessionMs / 1000}; ${cookieOptions}`, `${legacyCookie}=; Max-Age=0; ${cookieOptions}`]);
    if (!allowsRoute(path, method)) throw new HttpError(403, "Administrator instance required");
    if (trusted && method === "GET" && path === "/api/gateway/instance") {
      return json(res, 200, { rss: process.memoryUsage.rss() });
    }
    if (method !== "GET" && method !== "HEAD" && req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw new HttpError(415, "Content-Type must be application/json");
    }
    if (login) {
      const { password } = await body(req);
      if (typeof password !== "string" || !timingSafeEqual(digest(password), passwordHash)) throw new HttpError(401, "Invalid password");
      const session = randomBytes(32).toString("base64url");
      sessions!.add(session);
      res.setHeader("Set-Cookie", `${cookieName}=${session}; Max-Age=${sessionMs / 1000}; ${cookieOptions}`);
    } else if (logout) {
      if (token) sessions?.delete(token);
      for (const [client, owner] of clients) if (owner === token) { clients.delete(client); client.end(); }
      res.setHeader("Set-Cookie", `${cookieName}=; Max-Age=0; ${cookieOptions}`);
    } else if (method === "GET" && path === "/api/nodes") {
      return json(res, 200, await app.nodes.all());
    } else if (path === "/api/nodes/adapter-presets" || /^\/api\/nodes\/[^/]+\/adapters(\/|$)/.test(path)) {
      const { status, data } = await nodeAdapterRoute(app.nodes, path, req);
      return method === "GET" ? json(res, status, data) : mutation(status, data);
    } else if (method === "GET" && /^\/api\/nodes\/[^/]+\/sessions$/.test(path)) {
      const query = new URL(req.url!, "http://localhost").searchParams;
      const harness = query.get("harness");
      if (!validHarness.check(harness)) throw new HttpError(400, "Invalid harness");
      return json(res, 200, await app.nodes.sessions(path.split("/")[3]!, harness, query.get("cwd") ?? undefined));
    } else if (method === "POST" && path === "/api/nodes") {
      const { name } = await body(req);
      if (typeof name !== "string" || !name.trim() || name.length > 128 || /[\x00-\x1f\x7f]/.test(name)) throw new HttpError(400, "Invalid node name");
      const origin = URL.parse(req.headers.origin ?? `http://${req.headers.host}`);
      if (!origin || !["https:", "http:"].includes(origin.protocol)) throw new HttpError(400, "Invalid server origin");
      const created = await app.nodes.create(name.trim());
      if (!created) throw new HttpError(409, "Node name already exists");
      const sh = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
      const ps = (s: string) => "'" + s.replace(/['‘’‚‛]/g, c => "'" + c) + "'";
      const env = { ALTER_SERVER: origin.origin, ALTER_TOKEN: created.token, ALTER_NAME: name.trim() };
      return mutation(201, { ...created,
        installCommandPowerShell: Object.entries(env).map(([k, v]) => `$env:${k}=${ps(v)}; `).join("") + `irm ${ps(origin.origin + "/node/install.ps1")} | iex`,
        installCommandUnix: `curl -fsSL ${sh(origin.origin + "/node/install.sh")} | ` + Object.entries(env).map(([k, v]) => `${k}=${sh(v)} `).join("") + "sh" });
    } else if (method === "DELETE" && /^\/api\/nodes\/[^/]+$/.test(path)) {
      if (!await app.nodes.revoke(path.split("/")[3]!)) throw new HttpError(404, "Unknown node");
    } else if (method === "GET" && path === "/api/service") {
      return json(res, 200, service?.state() ?? { supported: false, managed: false, autostart: false, keepAlive: false,
        preventSleep: false, restrictedCapabilities: RESTRICTED_HOST_CAPABILITIES });
    } else if (method === "PUT" && path === "/api/service") {
      const change = service!.update(await body(req));
      json(res, 200, change.state);
      try {
        await finished(res, { cleanup: true });
        await activity();
      } finally { await change.apply(); }
      return;
    } else if (method === "GET" && path === "/api/debug/traces") {
      const query = new URL(req.url!, "http://localhost").searchParams;
      const limit = Number(query.get("limit") ?? 50);
      const before = query.get("before") ?? undefined;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "Expected limit from 1 to 100");
      if (before !== undefined && (!/^-?\d+\.[1-9]\d*$/.test(before) || !before.split(".").every(n => Number.isSafeInteger(Number(n))))) {
        throw new HttpError(400, "Invalid trace cursor");
      }
      return json(res, 200, app.traces.list({ conversation: query.get("conversation") ?? "main", trigger: query.get("trigger") ?? undefined, limit, before }));
    } else if (method === "GET" && path.startsWith("/api/debug/traces/")) {
      const id = path.slice("/api/debug/traces/".length);
      const trace = /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) && app.traces.detail(Number(id));
      if (!trace) throw new HttpError(404, "Trace not found");
      return json(res, 200, trace);
    } else if (method === "GET" && path.startsWith("/api/debug/prompts/")) {
      const prompt = app.traces.prompt(path.slice("/api/debug/prompts/".length));
      if (!prompt) throw new HttpError(404, "Prompt not found");
      return json(res, 200, prompt);
    } else if (method === "GET" && path === "/api/debug/schedule") {
      return json(res, 200, await app.debugSchedule());
    } else if (method === "GET" && path === "/api/state") {
      return json(res, 200, surface.snapshot());
    } else if (method === "GET" && path === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
      clients.set(res, token ?? "");
      const entryStream = new URL(req.url!, "http://localhost").searchParams.get("memory") === "entries";
      const stopMemory = app.memory.subscribe(items => {
        if (clients.has(res)) write(res, frame("memory", entryStream ? app.memory.store.view() : items));
      });
      res.on("close", () => { clients.delete(res); stopMemory(); });
      const snapshot = surface.snapshot();
      write(res, frame("snapshot", snapshot));
      if (clients.has(res)) webDelivery(snapshot.notifications);
      if (surface.partial) write(res, frame("delta", surface.partial));
      if (plugins) write(res, frame("plugins", plugins.list()));
      if (ext) write(res, frame("ext-plugins", ext.list()));
      for (const { feed } of feeds.values()) if (feed.onConnect !== false) write(res, frame(feed.event, feed.snapshot()));
      write(res, frame("feedback", latestFeedback));
      return;
    } else if (method === "POST" && path === "/api/messages") {
      const { text } = await body(req);
      if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Expected non-empty text");
      return json(res, 202, { id: await submitMessage(app.main, text) });
    } else if (method === "POST" && /^\/api\/permissions\/[^/]+$/.test(path)) {
      const input = await body(req);
      const { note } = input;
      const exact = input.decision === "call";
      const decision = exact ? "once" : "decision" in input ? parseApprovalDecision(input.decision) : input.allow === true ? "once" : input.allow === false ? "deny" : undefined;
      if (!decision || ("decision" in input && "allow" in input) || (note !== undefined && typeof note !== "string")) {
        throw new HttpError(400, "Expected an approval decision and optional string note");
      }
      const answer = await answerUserPermission(app.main, { requestId: path.split("/")[3]!, decision, note, ...(exact && { exact: true }) });
      // The broker treats a duplicate signal as an idempotent success. HTTP distinguishes it from a first decision.
      if (answer.isError || answer.output[0]?.text !== "delivered") throw new HttpError(409, answer.output[0]?.text ?? "No pending user decision");
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
      if (!await updateNotification(app.main, path.split("/")[3]!, patch, app.now())) throw new HttpError(404, "Unknown notification");
    } else if (method === "GET" && path === "/api/feedback") {
      return json(res, 200, await app.feedback.view());
    } else if (method === "GET" && path === "/api/feedback/export") {
      res.setHeader("Content-Disposition", 'attachment; filename="alter-weekly-feedback.json"');
      return json(res, 200, (await app.feedback.stats()).weekly);
    } else if (method === "GET" && path === "/api/feedback/stats") {
      return json(res, 200, await app.feedback.stats());
    } else if (method === "POST" && path === "/api/feedback/more") {
      return json(res, 200, await app.feedback.more());
    } else if (method === "POST" && /^\/api\/feedback\/[^/]+\/(answer|skip)$/.test(path)) {
      const id = path.split("/")[3]!;
      if (path.endsWith("/skip")) await app.feedback.skip(id);
      else await app.feedback.answer(id, await body(req));
    } else if (method === "POST" && /^\/api\/feedback\/changes\/[^/]+\/undo$/.test(path)) {
      await app.feedback.undo(path.split("/")[4]!);
    } else if (method === "GET" && path === "/api/memory") {
      return json(res, 200, legacyMemory(req) ? app.memory.list() : app.memory.store.view());
    } else if (method === "GET" && path === "/api/memory/changes") {
      return json(res, 200, app.memory.store.changes());
    } else if (method === "POST" && /^\/api\/memory\/changes\/[^/]+\/undo$/.test(path)) {
      if (!app.memory.store.undo(path.split("/")[4]!)) throw new HttpError(404, "Unknown memory change");
    } else if (method === "GET" && /^\/api\/memory\/[^/]+$/.test(path)) {
      app.memory.store.refresh();
      const entry = app.memory.store.read(path.split("/")[3]!);
      if (!entry) throw new HttpError(404, "Unknown memory");
      return json(res, 200, entry);
    } else if ((method === "PATCH" || method === "DELETE") && /^\/api\/memory\/[^/]+$/.test(path)) {
      const id = path.split("/")[3]!;
      const found = method === "PATCH" ? app.memory.update(id, await body(req)) : app.memory.delete(id);
      if (!found) throw new HttpError(404, "Unknown memory");
    } else if (method === "GET" && path === "/api/schedules") {
      return json(res, 200, await app.schedules.list());
    } else if ((method === "PATCH" || method === "DELETE") && /^\/api\/schedules\/[^/]+$/.test(path)) {
      const id = path.split("/")[3]!;
      if (method === "PATCH") {
        const patch = await body(req);
        if (typeof patch.paused !== "boolean" || Object.keys(patch).length !== 1) throw new HttpError(400, "Expected { paused: boolean }");
        if (!await app.schedules.pause(id, patch.paused)) throw new HttpError(404, "Unknown or finished schedule");
      } else if (!await app.schedules.cancel(id)) throw new HttpError(404, "Unknown schedule");
    } else if (method === "GET" && path === "/api/funnel") {
      const values = new URL(req.url!, "http://localhost").searchParams.getAll("days");
      const days = Number(values[0] ?? 7);
      if (values.length > 1 || !/^\d+$/.test(values[0] ?? "7") || !Number.isSafeInteger(days) || days < 1 || days > 366) {
        throw new HttpError(400, "days must be an integer between 1 and 366");
      }
      return json(res, 200, funnel(surface.snapshot().notifications, app.timeZone, days, { at: app.now(), hasExternalChannel: hasExternalChannel() }));
    } else if (method === "GET" && path === "/api/watches") {
      return json(res, 200, await app.watches.list());
    } else if (method === "DELETE" && /^\/api\/watches\/[^/]+$/.test(path)) {
      const id = path.split("/")[3]!;
      if (!surface.snapshot().watches.some(w => w.id === id)) throw new HttpError(404, "Unknown watch");
      if (!await app.watches.cancel(id)) throw new HttpError(409, "Watch has ended");
    } else if (method === "GET" && path === "/api/heartbeat") {
      return json(res, 200, await app.heartbeat.view());
    } else if (method === "POST" && path === "/api/heartbeat/run") {
      await activity();
      const run = await app.heartbeat.run();
      if (run.skipReason === "busy") return json(res, 409, { error: "Main conversation is busy", id: run.id });
      return json(res, run.status === "ran" ? 202 : 200, run);
    } else if (method === "POST" && /^\/api\/heartbeat\/[^/]+\/feedback$/.test(path)) {
      const { feedback } = await body(req);
      if (feedback !== "useful" && feedback !== "useless") throw new HttpError(400, "Expected useful or useless feedback");
      const result = await app.heartbeat.feedback(path.split("/")[3]!, feedback);
      if (result === "missing") throw new HttpError(404, "Unknown heartbeat");
      if (result === "skipped") throw new HttpError(409, "Heartbeat did not run");
    } else if (method === "GET" && path === "/api/heartbeat/stats") {
      return json(res, 200, await app.heartbeat.stats());
    } else if (method === "GET" && path === "/api/approvals/stats") {
      return json(res, 200, await approvalStats(app.main));
    } else if (method === "GET" && path === "/api/adapters") {
      return json(res, 200, adapters?.list() ?? []);
    } else if (method === "GET" && path === "/api/adapters/presets") {
      return json(res, 200, adapterPresets);
    } else if (adapters && method === "POST" && path === "/api/adapters") {
      return mutation(201, await adapters.create(await body(req)));
    } else if (adapters && method === "POST" && /^\/api\/adapters\/[^/]+\/refresh$/.test(path)) {
      return mutation(200, await adapters.refresh(path.split("/")[3]!));
    } else if (adapters && method === "POST" && /^\/api\/adapters\/presets\/[^/]+$/.test(path)) {
      return mutation(201, await adapters.create(presetConfig(path.split("/")[4]!, await body(req))));
    } else if (adapters && (method === "PATCH" || method === "DELETE") && /^\/api\/adapters\/[^/]+$/.test(path)) {
      const id = path.split("/")[3]!;
      if (method === "PATCH") return mutation(200, await adapters.patch(id, await body(req)));
      await adapters.remove(id);
    } else if (method === "GET" && path === "/api/ext-plugins") {
      return json(res, 200, ext?.list() ?? []);
    } else if (ext && method === "POST" && path === "/api/ext-plugins/install") {
      return mutation(201, await ext.install(await body(req)));
    } else if (ext && method === "POST" && /^\/api\/ext-plugins\/[^/]+\/(approve|reject|rollback|disable|enable)$/.test(path)) {
      const [, , , id, action] = path.split("/");
      await ext.action(id!, action!, await body(req, action !== "approve"));
    } else if (ext && method === "DELETE" && /^\/api\/ext-plugins\/[^/]+$/.test(path)) {
      await ext.action(path.split("/")[3]!, "delete", {});
    } else if (method === "GET" && path === "/api/plugins") {
      return json(res, 200, plugins?.list() ?? []);
    } else if (plugins && method === "PATCH" && /^\/api\/plugins\/[^/]+$/.test(path)) {
      return mutation(200, await plugins.get(path.split("/")[3]!).patch(await body(req)));
    } else if (plugins && method === "POST" && /^\/api\/plugins\/[^/]+\/check$/.test(path)) {
      return mutation(200, await plugins.get(path.split("/")[3]!).check());
    } else if (method === "GET" && path === "/api/models") {
      return json(res, 200, app.modelCapabilities?.list() ?? []);
    } else if (method === "PUT" && path.startsWith("/api/models/")) {
      const values = await body(req);
      if (!validModelOverrides.check(values)) throw new HttpError(400, "Invalid model capabilities");
      const result = app.modelCapabilities?.replace(path.slice("/api/models/".length), values);
      if (!result) throw new HttpError(404, "Unknown configured model");
      return mutation(200, result);
    } else if (method === "GET" && path === "/api/settings/always-allowed") {
      const grants = await app.harness.snapshot(AllowedCapabilities, app.main.id, context);
      return json(res, 200, { capabilities: grants?.capabilities ?? [] });
    } else if (method === "DELETE" && /^\/api\/settings\/always-allowed\/[^/]+$/.test(path)) {
      const capability = decodeURIComponent(path.split("/")[4]!);
      const capabilities = await app.main.commit(async tx => {
        const grants = await tx.doc(AllowedCapabilities, app.main.id);
        grants.capabilities = grants.capabilities.filter(id => id !== capability);
        return [...grants.capabilities];
      }, context);
      return json(res, 200, { capabilities });
    } else if ((method === "GET" || method === "PATCH") && path === "/api/settings") {
      if (method === "PATCH") {
        const patch = await body(req);
        await saveSettings(patch);
        await activity();
      }
      return json(res, 200, { approvalModel: app.settings.approvalModel, heartbeat: app.settings.heartbeat, compactAtTokens: app.settings.compactAtTokens });
    } else if (method === "GET" && path === "/api/stats") {
      const values = new URL(req.url!, "http://localhost").searchParams.getAll("range");
      const range = values[0] ?? "7d";
      if (values.length > 1 || (range !== "day" && range !== "7d" && range !== "30d" && range !== "all")) {
        throw new HttpError(400, "range must be day, 7d, 30d or all");
      }
      return json(res, 200, await stats(range, app.timeZone, { app, dir: options.dataDir, hasExternalChannel: hasExternalChannel() }));
    } else if (method === "GET" && path === "/api/usage") {
      return json(res, 200, await usageSummary(options.dataDir));
    } else if (route) return route.handle(routeContext);
    else throw new HttpError(404, "Unknown endpoint");
    if (!logout) await activity();
    res.writeHead(204).end();
  }

  const server: ReturnType<typeof createServer> = createServer({
    shouldUpgradeCallback: req => server.listenerCount("upgrade") > 0 && (!gatewayMode || trustedGateway(req)),
  }, (req, res) => {
    handle(req, res).catch((cause: unknown) => {
      const error = cause instanceof AdapterError || cause instanceof FeedbackError || cause instanceof PluginHttpError || cause instanceof PluginError || cause instanceof NodeSessionsError ? new HttpError(cause.status, cause.message)
        : cause instanceof MemoryConflict ? new HttpError(409, cause.message)
        : cause instanceof MemoryInputError ? new HttpError(400, cause.message) : cause;
      if (!(error instanceof HttpError)) console.error("Alter web request failed", error);
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof HttpError) json(res, error.status, { error: error.message });
      else json(res, 500, { error: "Internal server error" });
    });
  });
  const closeNodes = attachNodeSockets(server, app.nodes);
  function dispose() {
    service?.close();
    clearInterval(ping);
    stopHeartbeat();
    stopPlugins?.();
    stopNodeUpdates();
    stopExt?.();
    for (const binding of feeds.values()) binding.stop();
    feeds.clear();
    surface.detach();
    for (const res of clients.keys()) res.end();
    clients.clear();
  }
  server.once("close", () => { dispose(); void closeNodes(); });
  return { server, async close() {
    dispose();
    await closeNodes();
    await deliveries;
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

