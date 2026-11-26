import { createHash, randomUUID } from "node:crypto";
import type { AlterPlugin, PluginDescription, PluginHost } from "@alter/core";
import { backoffDelay, distinctItems, localDay, rememberItems, runPollBatch, type PollerState } from "@alter/plugin-sdk/poller";
import { config, keys, publicParams, record, resolvedHeaders, SourceError, type Config, type Item } from "./config.ts";
import { pull, PullError, type PullOptions } from "./pull.ts";

export { templates, SourceError, type Item } from "./config.ts";
type Secrets = { get(key: string): string | boolean | undefined; patch(values: Record<string, string | null>): void };
type State = Omit<PollerState, "minIntervalMs"> & { id: string; config: Config; lastModified?: string; pollMs?: number };
export type SourceView = ReturnType<typeof view>;
function view(s: State, day: string) {
  const { name, template, enabled, intervalMinutes } = s.config;
  return { id: s.id, template, name, intervalMinutes, enabled, params: publicParams(s.config),
    status: { lastPollAt: s.lastPollAt, nextPollAt: enabled ? s.nextPollAt : null, todayCount: s.day === day ? s.count : 0, error: s.error } };
}
function sanitizer(spec: Config): (item: Item) => Item {
  const values = spec.template === "github" ? [spec.params.token] : spec.template === "json" ?
    [...Object.values(spec.params.secrets), ...Object.values(resolvedHeaders(spec.params))] : [];
  if (!values.length) return item => item;
  const secrets = new Set(values);
  for (const value of values) {
    const bearer = /^Bearer\s+(.+)$/i.exec(value);
    if (bearer) secrets.add(bearer[1]!);
  }
  return item => {
    const safe = { ...item };
    for (const key of Object.keys(safe) as (keyof Item)[]) {
      for (const value of secrets) {
        if (safe[key]!.includes(value)) { safe[key] = "***"; break; }
      }
    }
    return safe;
  };
}

const catalog = "sources.ids";
const key = (id: string) => "sources.instance." + id;
const intervalMs = (spec: Config) => spec.intervalMinutes * 60_000;
export function openSources(store: Secrets, timeZone: string, options: PullOptions & { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const day = () => localDay(now(), timeZone);
  const states = new Map<string, State>();
  const ids: string[] = JSON.parse(String(store.get(catalog) ?? "[]"));
  for (const id of ids) {
    const persisted = JSON.parse(String(store.get(key(id)))) as State;
    states.set(id, { ...persisted, invalid: persisted.invalid ?? 0, paused: persisted.paused ?? false });
  }
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
    if (!active || !state?.config.enabled || state.paused) return;
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
  async function poll(previous: State, active: NonNullable<typeof runtime>) {
    const { config: spec, id, lastModified, pollMs, ...checkpoint } = previous;
    const signal = active.stop.signal;
    let sanitize: ReturnType<typeof sanitizer> | undefined;
    const result = await runPollBatch({ ...checkpoint, minIntervalMs: pollMs }, {
      intervalMs: intervalMs(spec), timeZone, now, signal,
      async pull() {
        const batch = await pull(spec, lastModified, options, signal);
        return { items: batch.items, minIntervalMs: batch.pollMs, metadata: batch.lastModified };
      },
      async onItem(item) {
        const display = (sanitize ??= sanitizer(spec))(item);
        await active.host.emit({ source: "feed:" + spec.name, kind: "new-message", untrusted: true, author: "external",
          at: now(), ref: "feed:" + id + "/" + createHash("sha256").update(item.id).digest("base64url"),
          summary: [display.repo, display.type, display.title, display.body, display.url].filter(Boolean).join(" — ").slice(0, 2000) });
      },
      classifyError(cause) {
        return { error: cause instanceof SourceError ? cause.message : "Source delivery failed",
          ...(cause instanceof PullError && { minIntervalMs: cause.pollMs, invalid: cause.invalid }) };
      },
    });
    if (!result) return;
    const { minIntervalMs, ...state } = result.state;
    save({ ...state, id, config: spec, pollMs: minIntervalMs, lastModified: result.status === "success" ? result.metadata : lastModified });
  }
  function existing(id: string) {
    const s = states.get(id);
    if (!s) throw new SourceError("Unknown source", 404);
    return s;
  }
  async function trial(input: Record<string, unknown>) {
    const spec = config(input, options.allowLocalHttp);
    const batch = await pull(spec, undefined, options);
    const items = distinctItems(batch.items);
    return { spec, batch, items, samples: items.slice(0, 3).map(sanitizer(spec)) };
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
    list() {
      const today = day();
      return [...states.values()].map(s => view(s, today));
    },
    subscribe(cb: (namesChanged: boolean) => void) { listeners.add(cb); return () => listeners.delete(cb); },
    async preview(input: Record<string, unknown>) {
      const { samples } = await trial({ name: "preview", ...input });
      return { samples };
    },
    async create(input: Record<string, unknown>) {
      const { spec, batch, items, samples } = await trial(input);
      const ids = items.map(i => i.id);
      const at = now();
      const s: State = { id: randomUUID(), config: spec, baseline: spec.enabled,
        ...rememberItems({ seen: [] }, items, new Set(ids), ids),
        lastModified: batch.lastModified, pollMs: batch.pollMs, failures: 0, invalid: 0, paused: false, error: null,
        day: localDay(at, timeZone), count: 0, lastPollAt: at, nextPollAt: at + backoffDelay(intervalMs(spec), 0, batch.pollMs) };
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
          Object.assign(s, { baseline: false, seen: [], overflow: undefined, failures: 0, invalid: 0, paused: false, error: null, lastModified: undefined });
          s.nextPollAt = Math.max(now(), s.lastPollAt + (s.pollMs ?? 0));
        } else if (spec.intervalMinutes !== old.config.intervalMinutes) s.nextPollAt = s.lastPollAt + backoffDelay(intervalMs(spec), s.failures, s.pollMs);
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
