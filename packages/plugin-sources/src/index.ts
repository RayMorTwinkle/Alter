import { createHash, randomUUID } from "node:crypto";
import type { AlterPlugin, PluginDescription, PluginHost } from "@alter/core";
import { config, keys, publicParams, record, resolvedHeaders, SourceError, type Config, type Item } from "./config.ts";
import { pull, PullError, type Batch, type PullOptions } from "./pull.ts";

export { templates, SourceError, type Item } from "./config.ts";
type Secrets = { get(key: string): string | boolean | undefined; patch(values: Record<string, string | null>): void };
type Overflow = { first: string; length: number; hash: string };
type State = { id: string; config: Config; seen: string[]; overflow?: Overflow; baseline: boolean; failures: number; lastPollAt: number;
  nextPollAt: number; day: string; count: number; error: string | null; lastModified?: string; pollMs?: number };
export type SourceView = ReturnType<typeof view>;
function view(s: State, day: string) {
  const { name, template, enabled, intervalMinutes } = s.config;
  return { id: s.id, template, name, intervalMinutes, enabled, params: publicParams(s.config),
    status: { lastPollAt: s.lastPollAt, nextPollAt: enabled ? s.nextPollAt : null, todayCount: s.day === day ? s.count : 0, error: s.error } };
}
function sanitized(items: Item[], spec: Config) {
  const values = spec.template === "github" ? [spec.params.token] : spec.template === "json" ?
    [...Object.values(spec.params.secrets), ...Object.values(resolvedHeaders(spec.params))] : [];
  if (!values.length) return items;
  const secrets = new Set(values);
  for (const value of values) {
    const bearer = /^Bearer\s+(.+)$/i.exec(value);
    if (bearer) secrets.add(bearer[1]!);
  }
  return items.map(item => {
    const safe = { ...item };
    for (const key of Object.keys(safe) as (keyof Item)[]) {
      for (const value of secrets) {
        if (safe[key]!.includes(value)) { safe[key] = "***"; break; }
      }
    }
    return safe;
  });
}
function distinct(batch: Batch) {
  const unique = new Map<string, Item>();
  for (const item of batch.items) if (!unique.has(item.id)) unique.set(item.id, item);
  return [...unique.values()];
}

// One digest recognizes an unchanged stretch of old IDs in feeds larger than the retained set.
function fingerprint(ids: string[]) {
  return createHash("sha256").update(JSON.stringify(ids)).digest("base64url");
}
function freshItems(items: Item[], seen: Set<string>, overflow?: Overflow) {
  const unseen = items.filter(i => !seen.has(i.id));
  if (overflow) {
    const start = unseen.findIndex(i => i.id === overflow.first);
    if (start >= 0 && start + overflow.length <= unseen.length) {
      const block = unseen.slice(start, start + overflow.length).map(i => i.id);
      if (fingerprint(block) === overflow.hash) {
        for (const id of block) seen.add(id);
        unseen.splice(start, block.length);
      }
    }
  }
  return unseen;
}
function remember(s: State, items: Item[], known: Set<string>, received: string[]) {
  s.seen = [...new Set([...received, ...s.seen])].slice(0, 1000);
  const retained = new Set(s.seen);
  const rest = items.map(i => i.id).filter(id => known.has(id) && !retained.has(id));
  s.overflow = rest.length ? { first: rest[0]!, length: rest.length, hash: fingerprint(rest) } : undefined;
}

const catalog = "sources.ids";
const key = (id: string) => "sources.instance." + id;
export function openSources(store: Secrets, timeZone: string, options: PullOptions & { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const day = () => date.format(now());
  const states = new Map<string, State>();
  const ids: string[] = JSON.parse(String(store.get(catalog) ?? "[]"));
  for (const id of ids) states.set(id, JSON.parse(String(store.get(key(id)))));
  const listeners = new Set<(namesChanged: boolean) => void>();
  const timers = new Map<string, NodeJS.Timeout>();
  const pending = new Map<string, Promise<unknown>>();
  let runtime: { host: PluginHost; stop: AbortController } | undefined;

  function ordered<T>(id: string, fn: () => T | Promise<T>) {
    const work = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
    pending.set(id, work);
    return work.finally(() => { if (pending.get(id) === work) pending.delete(id); });
  }
  function notify(namesChanged: boolean) { for (const cb of listeners) cb(namesChanged); }
  function schedule(id: string) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    const state = states.get(id);
    const active = runtime;
    if (!active || !state?.config.enabled) return;
    const ms = Math.min(2_147_483_647, Math.max(0, state.nextPollAt - now()));
    timers.set(id, setTimeout(() => {
      void ordered(id, async () => {
        if (states.get(id) === state && runtime === active && now() >= state.nextPollAt) await poll(state, active);
      }).catch(() => {
        // A storage failure must not cause an immediate retry loop.
        state.nextPollAt = Math.max(state.nextPollAt, now() + 300_000);
        state.error = "Could not persist source poll progress";
        notify(false);
        console.warn("Alter could not persist source poll progress");
      }).finally(() => schedule(id));
    }, ms).unref());
  }
  function save(state: State) {
    const fresh = !states.has(state.id);
    store.patch({ [key(state.id)]: JSON.stringify(state), ...(fresh && { [catalog]: JSON.stringify([...states.keys(), state.id]) }) });
    const renamed = states.get(state.id)?.config.name !== state.config.name;
    states.set(state.id, state);
    schedule(state.id);
    notify(renamed);
  }
  function delay(s: State) {
    return Math.max(s.config.intervalMinutes * 60_000 * 2 ** Math.min(s.failures, 6), s.pollMs ?? 0);
  }
  async function poll(previous: State, active: NonNullable<typeof runtime>) {
    const s = { ...previous };
    const seen = new Set(s.seen);
    const emitted: string[] = [];
    let items: Item[] = [];
    try {
      const batch = await pull(s.config, s.lastModified, options, active.stop.signal);
      items = distinct(batch);
      s.pollMs = batch.pollMs ?? s.pollMs;
      const fresh = freshItems(items, seen, s.overflow);
      if (s.baseline) {
        const safe = sanitized(fresh, s.config);
        for (const [i, item] of fresh.entries()) {
          active.stop.signal.throwIfAborted();
          const display = safe[i]!;
          await active.host.emit({ source: "feed:" + s.config.name, kind: "new-message", untrusted: true, author: "external",
            at: now(), ref: "feed:" + s.id + "/" + createHash("sha256").update(item.id).digest("base64url"),
            summary: [display.repo, display.type, display.title, display.body, display.url].filter(Boolean).join(" — ").slice(0, 2000) });
          emitted.push(item.id);
          seen.add(item.id);
          if (s.day !== day()) { s.day = day(); s.count = 0; }
          s.count++;
        }
      } else {
        for (const item of items) { seen.add(item.id); emitted.push(item.id); }
      }
      s.baseline = true;
      s.lastModified = batch.lastModified;
      s.failures = 0;
      s.error = null;
    } catch (cause) {
      if (active.stop.signal.aborted && !emitted.length) return;
      if (!active.stop.signal.aborted) {
        s.failures++;
        s.error = cause instanceof SourceError ? cause.message : "Source delivery failed";
        if (cause instanceof PullError) s.pollMs = cause.pollMs ?? s.pollMs;
      }
    }
    if (items.length) remember(s, items, seen, emitted);
    s.lastPollAt = now();
    s.nextPollAt = active.stop.signal.aborted ? now() : now() + delay(s);
    save(s);
  }
  function existing(id: string) {
    const s = states.get(id);
    if (!s) throw new SourceError("Unknown source", 404);
    return s;
  }
  async function trial(input: Record<string, unknown>) {
    const spec = config(input, options.allowLocalHttp);
    const batch = await pull(spec, undefined, options);
    const items = distinct(batch);
    return { spec, batch, items, samples: sanitized(items.slice(0, 3), spec) };
  }
  const plugin: AlterPlugin = {
    capability: { id: "sources", actions: [], mainLeasable: false }, tools: [],
    async start(host) {
      const stop = new AbortController();
      runtime = { host, stop };
      for (const id of states.keys()) schedule(id);
      return async () => {
        runtime = undefined;
        stop.abort();
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        await Promise.allSettled(pending.values());
      };
    },
  };
  const description: PluginDescription = { id: "sources", name: "模板消息来源", settings: [],
    get provides() { return { channels: [], capabilities: [], sources: [...states.values()].map(s => s.config.name) }; } };
  return {
    description, plugin,
    list: () => [...states.values()].map(s => view(s, day())),
    subscribe(cb: (namesChanged: boolean) => void) { listeners.add(cb); return () => listeners.delete(cb); },
    async preview(input: Record<string, unknown>) {
      const { samples } = await trial({ name: "preview", ...input });
      return { samples };
    },
    async create(input: Record<string, unknown>) {
      const { spec, batch, items, samples } = await trial(input);
      const s: State = { id: randomUUID(), config: spec, baseline: spec.enabled, seen: [],
        lastModified: batch.lastModified, pollMs: batch.pollMs, failures: 0, error: null, day: day(), count: 0, lastPollAt: now(), nextPollAt: 0 };
      const ids = items.map(i => i.id);
      remember(s, items, new Set(ids), ids);
      s.nextPollAt = now() + delay(s);
      save(s);
      return { source: view(s, day()), samples };
    },
    patch(id: string, input: Record<string, unknown>) {
      return ordered(id, () => {
        const old = existing(id);
        keys(input, ["name", "params", "intervalMinutes", "enabled"]);
        if (!Object.keys(input).length || ("params" in input && !record(input.params))) throw new SourceError("Invalid source patch");
        const params = { ...old.config.params, ...(record(input.params) && input.params) };
        const spec = config({ ...old.config, ...input, params }, options.allowLocalHttp);
        const reset = JSON.stringify(spec.params) !== JSON.stringify(old.config.params) || (!old.config.enabled && spec.enabled);
        const s = { ...old, config: spec };
        if (reset) {
          Object.assign(s, { baseline: false, seen: [], overflow: undefined, failures: 0, error: null, lastModified: undefined });
          s.nextPollAt = Math.max(now(), s.lastPollAt + (s.pollMs ?? 0));
        } else if (spec.intervalMinutes !== old.config.intervalMinutes) s.nextPollAt = s.lastPollAt + delay(s);
        save(s);
        return view(s, day());
      });
    },
    remove(id: string) {
      return ordered(id, () => {
        existing(id);
        store.patch({ [key(id)]: null, [catalog]: JSON.stringify([...states.keys()].filter(k => k !== id)) });
        states.delete(id);
        schedule(id);
        notify(true);
      });
    },
  };
}
export type Sources = ReturnType<typeof openSources>;
export { sourcesWeb } from "./web.ts";
