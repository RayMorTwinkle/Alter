import { ownerOnly, writePrivate } from "./private-file.ts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { discoverCli } from "./cli.ts";
import { changes, check, definition, fields } from "./config.ts";
import { discoverHttp } from "./http.ts";
import { discoverMcp } from "./mcp.ts";
import { AdapterError, record, reply, type Result, type AdapterDefinition, type AdapterEntry, type AdapterStatus, type AdapterTool, type AdapterView, type Connection } from "./types.ts";
import type { openSecrets } from "./secrets.ts";

const exec = promisify(execFile);
async function ghAuthToken(signal: AbortSignal) {
  try {
    const { stdout } = await exec("gh", ["auth", "token"], { signal, timeout: 10_000 });
    if (stdout.trim()) return stdout.trim();
  } catch { /* gh stderr may contain credentials. */ }
  throw new Error("本机 gh 未登录或不可用，请运行 gh auth login");
}

type Snapshot = AdapterTool & { sourceName?: string };
type Entry = Omit<AdapterEntry, "tools" | "kind" | "config"> & AdapterDefinition & { tools: Snapshot[] };
const capability = (e: Entry) => (e.kind === "http" ? "api" : e.kind) + "-" + e.id;
const prefix = (id: string) => "adapter:" + id + ":";
const effect = (e: Entry, t: Pick<AdapterTool, "name" | "defaultEffect">) => Object.hasOwn(e.effects, t.name) ? e.effects[t.name]! : t.defaultEffect;

function containsSecret(value: unknown, credentials: string[], strict: boolean, templates = false): boolean {
  if (!credentials.length) return false;
  if (typeof value === "string") {
    const literal = templates ? value.replace(/\{\{secret:[A-Za-z0-9_-]+\}\}/g, "") : value;
    // Preserve host configurations with short values such as templated port numbers.
    return credentials.some(v => literal === v || (strict || v.length >= 8) &&
      (literal.includes(v) || literal.includes(JSON.stringify(v).slice(1, -1))));
  }
  if (Array.isArray(value)) return value.some(item => containsSecret(item, credentials, strict, templates));
  return record(value) && Object.entries(value).some(([key, child]) =>
    containsSecret(key, credentials, strict) || containsSecret(child, credentials, strict, templates));
}

function snapshots(entry: Entry, connection: Connection, maxName = 63): Snapshot[] {
  const limit = Math.min(maxName, 63 - capability(entry).length);
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
  call?: AdapterCall; controller: AbortController; status: AdapterStatus; connection?: Connection; retry?: NodeJS.Timeout;
  calls: Set<Promise<unknown>>; credentials: string[]; githubTokens: string[];
};

type Hooks = {
  register?(adapter: AdapterView, call: AdapterCall): Promise<void>;
  unregister?(capabilityId: string, preserve: boolean): Promise<void>;
  redactOutput?: boolean;
  maxToolName?: number;
  protectFile?: (file: string) => void;
};
export type AdapterCall = (name: string, args: unknown, signal?: AbortSignal) => Promise<Result>;

export function openAdapterEngine(dir: string, secrets: ReturnType<typeof openSecrets>, hooks: Hooks = {}) {
  const file = join(dir, "adapters.json");
  let entries = new Map<string, Entry>();
  try {
    const saved: Entry[] = JSON.parse(readFileSync(file, "utf8"));
    (hooks.protectFile ?? ownerOnly)(file);
    entries = new Map(saved.map(e => [e.id, e]));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const sessions = new Map<string, Session>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const fn of listeners) fn(); };
  const queues = new Map<string, Promise<void>>();
  let closed = false, closing: Promise<void> | undefined;
  function ordered<T>(id: string, fn: () => Promise<T>, signal?: AbortSignal) {
    const result = (queues.get(id) ?? Promise.resolve()).then(() => {
      signal?.throwIfAborted();
      if (closed) throw new AdapterError(503, "Server shutting down");
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
      writePrivate(temp, JSON.stringify([...revised.values()]), hooks.protectFile);
      if (Object.keys(patch).length) secrets.patch(patch);
      try { renameSync(temp, file); }
      catch (error) { if (Object.keys(undo).length) secrets.patch(undo); throw error; }
      entries = revised;
    } finally { rmSync(temp, { force: true }); }
  }
  function get(id: string) {
    const e = entries.get(id);
    if (!e) throw new AdapterError(404, "Unknown adapter");
    return e;
  }
  const secretNames = (id: string) => secrets.names(prefix(id)).map(k => k.slice(prefix(id).length));
  function view(e: Entry): AdapterView {
    return { ...e, capabilityId: capability(e), secretNames: secretNames(e.id),
      tools: e.tools.map(({ name, description, inputSchema, defaultEffect }) => ({ name, description, inputSchema, defaultEffect, effect: effect(e, { name, defaultEffect }) })),
      status: sessions.get(e.id)?.status ?? { state: e.enabled ? "connecting" : "off" } };
  }
  function secretValues(id: string) {
    return secretNames(id).map(k => String(secrets.get(prefix(id) + k))).sort((a, b) => b.length - a.length);
  }
  function redact(text: string, values: string[]) {
    for (const v of values) {
      // CLI and OpenAPI wrap output in JSON, which escapes quotes and control characters.
      text = text.replaceAll(JSON.stringify(v).slice(1, -1), "[redacted]").replaceAll(v, "[redacted]");
    }
    return text;
  }
  async function stop(e: Entry, preserve = false) {
    const s = sessions.get(e.id);
    sessions.delete(e.id);
    clearTimeout(s?.retry);
    s?.controller.abort();
    try { await hooks.unregister?.(capability(e), preserve); }
    finally {
      await s?.connection?.close?.();
      if (s) await Promise.allSettled(s.calls);
    }
  }
  function caller(e: Entry, s: Session, connection: Connection): AdapterCall {
    return async (name, args, signal) => {
      try {
        if (sessions.get(e.id) !== s || entries.get(e.id) !== e || s.controller.signal.aborted)
          throw new Error("Adapter configuration changed");
        const index = e.tools.findIndex(t => t.name === name);
        if (index < 0) throw new Error("Unknown adapter tool");
        const lifetime = signal ? AbortSignal.any([s.controller.signal, signal]) : s.controller.signal;
        lifetime.throwIfAborted();
        const call = connection.tools[index]!.call(record(args) ? args : {}, lifetime);
        s.calls.add(call);
        try {
          const result = await call;
          const sensitive = hooks.redactOutput ? s.credentials : s.githubTokens;
          for (const part of result.output) if (part.type === "text") part.text = redact(part.text, sensitive);
          return result;
        } finally { s.calls.delete(call); }
      } catch (error) {
        return reply(redact(error instanceof Error ? error.message : "Adapter tool failed", s.credentials), true);
      }
    };
  }
  async function register(e: Entry, s: Session, connection: Connection) {
    s.call = caller(e, s, connection);
    await hooks.register?.(view(e), s.call);
  }
  async function reload(e: Entry, delay = 1000) {
    await stop(e, e.enabled);
    if (!e.enabled || closed) { notify(); return; }
    const credentials = secretValues(e.id);
    const storedToken = secrets.get(prefix(e.id) + "GITHUB_TOKEN");
    const s: Session = { controller: new AbortController(), status: { state: "connecting" }, calls: new Set(),
      credentials, githubTokens: typeof storedToken === "string" ? [storedToken] : [] };
    sessions.set(e.id, s);
    notify();
    let ghToken: Promise<string> | undefined;
    const expand = async (text: string) => {
      let localToken: string | undefined;
      if (text.includes("{{gh-token}}")) {
        ghToken ??= ghAuthToken(s.controller.signal).then(token => {
          s.githubTokens.unshift(token);
          credentials.unshift(token);
          return token;
        });
        localToken = await ghToken;
      }
      return text.replace(/\{\{(?:secret:([A-Za-z0-9_-]+)|gh-token)\}\}/g, (_, key?: string) => {
        if (key === undefined) return localToken!;
        const v = secrets.get(prefix(e.id) + key);
        if (typeof v !== "string") throw new Error("Missing secret: " + key);
        return v;
      });
    };
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
        void ordered(e.id, async () => { if (sessions.get(e.id) === s) await hooks.unregister?.(capability(e), true); }).catch(() => {});
      };
      let connection: Connection;
      switch (e.kind) {
        case "mcp": connection = await discoverMcp(e.config, expand, signal, onDisconnect); break;
        case "cli": connection = await discoverCli(e.config, e.name, expand, signal); break;
        case "http": connection = await discoverHttp(e.config, expand, signal); break;
      }
      s.connection = connection;
      signal.throwIfAborted();
      const tools = snapshots(e, connection, hooks.maxToolName);
      for (const t of tools) {
        t.description = redact(t.description, credentials);
        if (containsSecret([t.name, t.sourceName, t.inputSchema], credentials, !!hooks.redactOutput)) {
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
    const values = [...secretValues(e.id), ...Object.values(updates).filter(Boolean)];
    const strict = !!hooks.redactOutput;
    check(!containsSecret(e.config, values, strict, true) && !containsSecret([e.id, e.name, e.tools, e.effects], values, strict),
      "Use a secret placeholder in config");
  }
  return {
    list: () => [...entries.values()].map(view),
    call(id: string, name: string, args: unknown, signal?: AbortSignal) {
      const s = sessions.get(id);
      if (!s?.call || s.status.state !== "ok") throw new AdapterError(409, "Adapter is unavailable");
      return s.call(name, args, signal);
    },
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
    create: (input: Record<string, unknown>, signal?: AbortSignal) => ordered(typeof input.id === "string" ? input.id : "", async () => {
      fields(input, "kind id name config secrets");
      const { id, name } = input;
      check(typeof id === "string" && /^[a-z0-9-]{1,48}$/.test(id), "Expected adapter ID of 1..48 lowercase letters, digits or hyphens");
      if (entries.has(id)) throw new AdapterError(409, "Adapter ID already exists");
      check(typeof name === "string" && name.trim(), "Expected display name");
      const p = changes({ name, ...(Object.hasOwn(input, "secrets") ? { secrets: input.secrets } : {}) });
      const e = { ...definition(input.kind, input.config), id, name, enabled: true, effects: {}, tools: [] };
      protectConfig(e, p.secrets);
      const unused = Object.fromEntries(secretNames(id).map(k => [k, ""]));
      save(e, id, { ...unused, ...p.secrets });
      await reload(e);
      return view(get(id));
    }, signal),
    patch: (id: string, input: Record<string, unknown>, signal?: AbortSignal) => ordered(id, () => patch(id, input), signal),
    setEffect: (id: string, tool: string, value: string) => ordered(id, () =>
      patch(id, { effects: { ...get(id).effects, [tool]: value } })),
    refresh: (id: string, signal?: AbortSignal) => ordered(id, async () => { await reload(get(id)); return view(get(id)); }, signal),
    remove: (id: string, signal?: AbortSignal) => ordered(id, async () => {
      const e = get(id);
      save(undefined, id, Object.fromEntries(secretNames(id).map(k => [k, ""])));
      await stop(e); notify();
    }, signal),
  };
}
