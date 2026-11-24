import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, reply, type AlterApp, type AlterPlugin, type PluginView } from "@alter/core";
import { discoverCli } from "./adapters/cli.ts";
import { changes, check, definition, fields } from "./adapters/config.ts";
import { discoverHttp } from "./adapters/http.ts";
import { discoverMcp } from "./adapters/mcp.ts";
import { record, type AdapterDefinition, type AdapterEntry, type AdapterStatus, type AdapterTool, type AdapterView, type Connection } from "./adapters/types.ts";
import type { openSecrets } from "./secrets.ts";
import { HttpError } from "./static.ts";

type Snapshot = AdapterTool & { sourceName?: string };
type Entry = Omit<AdapterEntry, "tools" | "kind" | "config"> & AdapterDefinition & { tools: Snapshot[] };
const capability = (e: Entry) => (e.kind === "http" ? "api" : e.kind) + "-" + e.id;
const prefix = (id: string) => "adapter:" + id + ":";
const effect = (e: Entry, t: Pick<AdapterTool, "name" | "defaultEffect">) => Object.hasOwn(e.effects, t.name) ? e.effects[t.name]! : t.defaultEffect;

function containsSecret(value: unknown, credentials: string[]): boolean {
  if (!credentials.length) return false;
  if (typeof value === "string") {
    const literal = value.replace(/\{\{secret:[A-Za-z0-9_-]+\}\}/g, "");
    // Short values can occur incidentally inside executable paths or schema keywords.
    return credentials.some(v => literal === v || v.length >= 8 && literal.includes(v));
  }
  return (Array.isArray(value) || record(value)) && Object.values(value).some(child => containsSecret(child, credentials));
}

function snapshots(entry: Entry, connection: Connection): Snapshot[] {
  const limit = 63 - capability(entry).length;
  const prior = new Map(entry.tools.map(t => [t.sourceName ?? t.name, t.name]));
  const names = new Map<string, string>(), used = new Set<string>();
  for (const { name } of connection.tools) {
    const old = prior.get(name);
    if (old) { names.set(name, old); used.add(old); }
  }
  const sources = connection.tools.map(t => t.name).sort();
  if (new Set(sources).size !== sources.length) throw new Error("Duplicate source tool name");
  for (const source of sources) {
    if (names.has(source)) continue;
    const base = source.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "tool";
    let name = base.slice(0, limit);
    for (let i = 2; used.has(name); i++) {
      const suffix = "_" + i;
      name = base.slice(0, limit - suffix.length) + suffix;
    }
    names.set(source, name); used.add(name);
  }
  return connection.tools.map(t => {
    const name = names.get(t.name)!;
    return { name, ...(name === t.name ? {} : { sourceName: t.name }), description: t.description, inputSchema: t.inputSchema, defaultEffect: t.defaultEffect };
  });
}

type Session = {
  controller: AbortController; status: AdapterStatus; connection?: Connection; retry?: NodeJS.Timeout;
  calls: Set<Promise<unknown>>;
};

export function openAdapters(app: AlterApp, dir: string, secrets: ReturnType<typeof openSecrets>) {
  const file = join(dir, "adapters.json");
  let entries = new Map<string, Entry>();
  try {
    const saved: Entry[] = JSON.parse(readFileSync(file, "utf8"));
    chmodSync(file, 0o600);
    entries = new Map(saved.map(e => [e.id, e]));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const sessions = new Map<string, Session>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const fn of listeners) fn(); };
  const queues = new Map<string, Promise<void>>();
  let closed = false, closing: Promise<void> | undefined;
  function ordered<T>(id: string, fn: () => Promise<T>) {
    const result = (queues.get(id) ?? Promise.resolve()).then(() => {
      if (closed) throw new HttpError(503, "Server shutting down");
      return fn();
    });
    const done = () => { if (queues.get(id) === pending) queues.delete(id); };
    const pending = result.then(done, done);
    queues.set(id, pending);
    return result;
  }
  function save(next: Entry | undefined, id: string, updates: Record<string, string> = {}) {
    const revised = new Map(entries);
    if (next) revised.set(id, next); else revised.delete(id);
    const patch = Object.fromEntries(Object.entries(updates).map(([k, v]) => [prefix(id) + k, v || null]));
    const undo = Object.fromEntries(Object.keys(patch).map(k => [k, secrets.get(k) ?? null]));
    const temp = file + "." + randomUUID();
    try {
      writeFileSync(temp, JSON.stringify([...revised.values()]), { mode: 0o600, flag: "wx" });
      if (Object.keys(patch).length) secrets.patch(patch);
      try { renameSync(temp, file); }
      catch (error) { if (Object.keys(undo).length) secrets.patch(undo); throw error; }
      entries = revised;
    } finally { rmSync(temp, { force: true }); }
  }
  function get(id: string) {
    const e = entries.get(id);
    if (!e) throw new HttpError(404, "Unknown adapter");
    return e;
  }
  const secretNames = (id: string) => secrets.names(prefix(id)).map(k => k.slice(prefix(id).length));
  function view(e: Entry): AdapterView {
    return { ...e, capabilityId: capability(e), secretNames: secretNames(e.id),
      tools: e.tools.map(({ name, description, inputSchema, defaultEffect }) => ({ name, description, inputSchema, defaultEffect, effect: effect(e, { name, defaultEffect }) })),
      status: sessions.get(e.id)?.status ?? { state: e.enabled ? "connecting" : "off" } };
  }
  function pluginView(e: Entry): PluginView {
    const v = view(e);
    return { id: v.capabilityId, name: v.name, enabled: v.enabled, status: v.status, settings: [], values: {},
      provides: { channels: [], capabilities: v.tools.map(t => v.capabilityId + "_" + t.name), sources: [] } };
  }
  function secretValues(id: string) {
    return secretNames(id).map(k => String(secrets.get(prefix(id) + k))).sort((a, b) => b.length - a.length);
  }
  function redact(text: string, values: string[]) {
    for (const v of values) text = text.replaceAll(v, "[redacted]");
    return text;
  }
  async function stop(e: Entry, preserve = false) {
    const s = sessions.get(e.id);
    sessions.delete(e.id);
    clearTimeout(s?.retry);
    s?.controller.abort();
    try { await app.replacePlugin(capability(e), undefined, preserve); }
    finally {
      await s?.connection?.close?.();
      if (s) await Promise.allSettled(s.calls);
    }
  }
  async function register(e: Entry, s: Session, connection: Connection) {
    const id = capability(e), credentials = secretValues(e.id);
    const plugin: AlterPlugin = { capability: { id, mainLeasable: true, actions: e.tools.map(t => ({ name: t.name, effect: effect(e, t) })) },
      tools: e.tools.map((t, i) => defineTool({ name: id + "_" + t.name, description: t.description, parameters: t.inputSchema,
        async execute(args, _api, ctx) {
          try {
            if (sessions.get(e.id) !== s || get(e.id) !== e || s.controller.signal.aborted) throw new Error("Adapter configuration changed");
            const signal = ctx.abortSignal ? AbortSignal.any([s.controller.signal, ctx.abortSignal]) : s.controller.signal;
            const call = connection.tools[i]!.call(record(args) ? args : {}, signal);
            s.calls.add(call);
            try { return { ...await call, details: { untrusted: true } }; }
            finally { s.calls.delete(call); }
          } catch (error) {
            return { ...reply(redact(error instanceof Error ? error.message : "Adapter tool failed", credentials), true), details: { untrusted: true } };
          }
        },
      })) };
    await app.replacePlugin(id, plugin);
  }
  async function reload(e: Entry, delay = 1000) {
    await stop(e, e.enabled);
    if (!e.enabled || closed) { notify(); return; }
    const s: Session = { controller: new AbortController(), status: { state: "connecting" }, calls: new Set() };
    sessions.set(e.id, s);
    notify();
    const credentials = secretValues(e.id);
    const expand = (text: string) => text.replace(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g, (_, key: string) => {
      const v = secrets.get(prefix(e.id) + key);
      if (typeof v !== "string") throw new Error("Missing secret: " + key);
      return v;
    });
    function failed(reason: string) {
      if (sessions.get(e.id) !== s || closed || s.controller.signal.aborted) return;
      s.status = { state: "error", detail: redact(reason, credentials).slice(0, 500) };
      s.controller.abort();
      if (e.kind === "mcp") s.retry = setTimeout(() => {
        void ordered(e.id, async () => { if (sessions.get(e.id) === s) await reload(get(e.id), Math.min(delay * 2, 60_000)); }).catch(() => {});
      }, delay).unref();
      notify();
    }
    try {
      const signal = s.controller.signal;
      const onDisconnect = (reason: string) => {
        if (signal.aborted) return;
        failed(reason);
        void ordered(e.id, async () => { if (sessions.get(e.id) === s) await app.replacePlugin(capability(e), undefined, true); }).catch(() => {});
      };
      let connection: Connection;
      switch (e.kind) {
        case "mcp": connection = await discoverMcp(e.config, expand, signal, onDisconnect); break;
        case "cli": connection = await discoverCli(e.config, e.name, expand, signal); break;
        case "http": connection = await discoverHttp(e.config, expand, signal); break;
      }
      s.connection = connection;
      signal.throwIfAborted();
      const tools = snapshots(e, connection);
      for (const t of tools) {
        t.description = redact(t.description, credentials);
        if (containsSecret([t.sourceName ?? t.name, t.inputSchema], credentials)) {
          throw new Error("Discovered tool metadata contains a configured secret");
        }
      }
      const effects = Object.fromEntries(tools.filter(t => e.tools.some(old => old.name === t.name &&
        (old.sourceName ?? old.name) === (t.sourceName ?? t.name)) && Object.hasOwn(e.effects, t.name)).map(t => [t.name, e.effects[t.name]!]));
      const next = { ...e, effects, tools };
      save(next, e.id);
      await register(next, s, connection);
      signal.throwIfAborted();
      s.status = { state: "ok" };
      delay = 1000;
      notify();
    } catch (error) {
      failed(error instanceof Error ? error.message : "Adapter discovery failed");
      await s.connection?.close?.();
      s.connection = undefined;
    }
  }
  async function patch(id: string, input: Record<string, unknown>) {
    const e = get(id), p = changes(input);
    const def = definition(e.kind, "config" in input ? input.config : e.config);
    if (p.effects) check(Object.keys(p.effects).every(k => e.tools.some(t => t.name === k)), "Unknown adapter tool");
    const next = { ...e, ...def, name: p.name ?? e.name, enabled: p.enabled ?? e.enabled, effects: p.effects ?? e.effects };
    protectConfig(next, p.secrets);
    save(next, id, p.secrets);
    const s = sessions.get(id);
    if ("effects" in input && Object.keys(input).length === 1 && s?.connection && s.status.state === "ok") {
      await register(next, s, s.connection); notify();
    } else await reload(next);
    return view(get(id));
  }
  function protectConfig(e: Entry, updates: Record<string, string> = {}) {
    check(!containsSecret(e.config, [...secretValues(e.id), ...Object.values(updates).filter(Boolean)]), "Use a secret placeholder in config");
  }
  return {
    list: () => [...entries.values()].map(view), views: () => [...entries.values()].map(pluginView),
    subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); },
    start: () => Promise.all([...entries.keys()].map(id => ordered(id, async () => {
      const e = entries.get(id);
      if (e && !sessions.has(id)) await reload(e);
    }))),
    close() {
      if (closing) return closing;
      closed = true;
      for (const s of sessions.values()) { clearTimeout(s.retry); s.controller.abort(); }
      closing = Promise.all(queues.values()).then(async () => {
        await Promise.all([...entries.values()].map(e => stop(e, true)));
      });
      return closing;
    },
    create: (input: Record<string, unknown>) => ordered(typeof input.id === "string" ? input.id : "", async () => {
      fields(input, "kind id name config secrets");
      const { id, name } = input;
      check(typeof id === "string" && /^[a-z0-9-]{1,48}$/.test(id), "Expected adapter ID of 1..48 lowercase letters, digits or hyphens");
      if (entries.has(id)) throw new HttpError(409, "Adapter ID already exists");
      check(typeof name === "string" && name.trim(), "Expected display name");
      const p = changes({ name, ...(Object.hasOwn(input, "secrets") ? { secrets: input.secrets } : {}) });
      const e = { ...definition(input.kind, input.config), id, name, enabled: true, effects: {}, tools: [] };
      protectConfig(e, p.secrets);
      const unused = Object.fromEntries(secretNames(id).map(k => [k, ""]));
      save(e, id, { ...unused, ...p.secrets });
      await reload(e);
      return view(get(id));
    }),
    patch: (id: string, input: Record<string, unknown>) => ordered(id, () => patch(id, input)),
    refresh: (id: string) => ordered(id, async () => { await reload(get(id)); return view(get(id)); }),
    remove: (id: string) => ordered(id, async () => {
      const e = get(id);
      save(undefined, id, Object.fromEntries(secretNames(id).map(k => [k, ""])));
      await stop(e); notify();
    }),
    getPlugin(cap: string) {
      const id = cap.slice(cap.indexOf("-") + 1);
      if (capability(get(id)) !== cap) throw new HttpError(404, "Unknown plugin");
      return {
        check: () => ordered(id, async () => { await reload(get(id)); return pluginView(get(id)); }),
        patch: (input: Record<string, unknown>) => ordered(id, async () => { fields(input, "enabled"); await patch(id, input); return pluginView(get(id)); }),
      };
    },
  };
}
export type Adapters = ReturnType<typeof openAdapters>;
