import { runPollBatch, type PollerState } from "@alter/plugin-sdk/poller";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { containsCredential, withholdCredentials } from "./credentials.ts";
import { createProxy } from "./http.ts";
import { check, fields, matches, record, validateToolInput, type Effect } from "./manifest.ts";
import { createWorkerHost, WorkerReset, type run, type HostCall, type Invoke } from "./process.ts";
import { openStore, freshProgress, type Version } from "./store.ts";

export { PluginError, check, fields, record, type Effect, type Manifest } from "./manifest.ts";
export type { Version } from "./store.ts";
type Host = {
  secrets(id: string, names: string[]): Record<string, string>;
  emit(event: { source: string; kind: string; at: number; untrusted: true; author: "external"; ref: string; summary: string }): Promise<void>;
  borrowSource?(id: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  notify(id: string, reason: string): Promise<void>;
  changed(): void;
};
type Caller = { signal?: AbortSignal; borrow(name: string, args: Record<string, unknown>, effect: Effect, signal: AbortSignal): Promise<unknown> };

class InvalidItems extends Error {}
function items(value: unknown) {
  if (!Array.isArray(value) || value.length > 4096) throw new InvalidItems("Invalid poll result");
  return value.map((item: unknown) => {
    if (!record(item) || typeof item.id !== "string" || !item.id || item.id.length > 2048 ||
      typeof item.title !== "string" || !["body", "url", "type", "repo", "publishedAt"].every(k => !(k in item) || typeof item[k] === "string")) {
      throw new InvalidItems("Invalid source item");
    }
    return { id: createHash("sha256").update(item.id).digest("hex"),
      summary: [item.repo, item.type, item.title, item.body, item.url].filter(Boolean).join(" — ").slice(0, 2000) };
  });
}
type Session = {
  secrets: Record<string, string>;
  stop: AbortController; polls: Set<string>; jobs: Set<Promise<unknown>>;
  worker?: ReturnType<typeof createWorkerHost>;
};
export function openRuntime(data: string, host: Host, adapters: { run?: typeof run; proxy?: typeof createProxy; timeZone?: string } = {}) {
  const timeZone = adapters.timeZone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const store = openStore(data, timeZone, id => { void stop(id); });
  const writeAudit = (e: object) => appendFileSync(join(store.root, "audit.jsonl"), JSON.stringify(e) + "\n", { mode: 0o600 });
  const audit = (e: object) => writeAudit({ at: Date.now(), ...e });
  const proxy = (adapters.proxy ?? createProxy)(audit);
  const sessions = new Map<string, Session>();
  const draining = new Map<string, Promise<void>>();
  const timers = new Map<string, NodeJS.Timeout>();
  const scheduled = new Set<string>();
  let closed = false;
  function stop(id: string) {
    scheduled.delete(id);
    clearTimeout(timers.get(id)); timers.delete(id);
    const session = sessions.get(id);
    if (!session) return draining.get(id) ?? Promise.resolve();
    sessions.delete(id);
    const exit = session.worker?.close();
    session.stop.abort();
    const done = Promise.allSettled([...session.jobs, exit]).then(() => { draining.delete(id); });
    draining.set(id, done);
    return done;
  }
  function schedule(id: string) {
    clearTimeout(timers.get(id)); timers.delete(id);
    if (closed) return;
    const version = store.active(id);
    if (version?.status !== "enabled") return;
    const names = version.manifest.secrets.map(s => s.name);
    const configured = host.secrets(id, names);
    if (!names.every(n => Object.hasOwn(configured, n))) return;
    scheduled.add(id);
    const stopping = draining.get(id);
    if (stopping) {
      void stopping.then(() => { if (scheduled.has(id)) schedule(id); });
      return;
    }
    const next = (name: string) => version.sources[name]?.nextPollAt ?? 0;
    const due = version.manifest.sources.filter(s => !version.sources[s.name]?.paused && !sessions.get(id)?.polls.has(s.name))
      .sort((a, b) => next(a.name) - next(b.name))[0];
    if (!due) return;
    const at = next(due.name);
    timers.set(id, setTimeout(() => {
      if (Date.now() >= at && !sessions.get(id)?.polls.has(due.name)) {
        void invoke(id, version.sha, { kind: "sources", name: due.name, args: null }).catch(() => {});
      }
      schedule(id);
    }, Math.min(2_147_483_647, Math.max(0, at - Date.now()))).unref());
  }
  function hostRequests(version: Version, call: Invoke, effect: Effect, signal: AbortSignal,
    secrets: Record<string, string>, caller?: Caller): HostCall {
    const m = version.manifest, id = m.id, sha = version.sha;
    const values = Object.values(secrets), names = m.secrets.map(s => s.name);
    async function request(method: string, p: unknown) {
      signal.throwIfAborted();
      if (method === "secrets.get") {
        fields(p, "name");
        check(typeof p.name === "string", "Invalid secret name");
        writeAudit({ plugin: id, secret: containsCredential(p.name, values) ? "[redacted]" : p.name, caller: call.name });
        check(names.includes(p.name), "Undeclared secret");
        return Object.hasOwn(secrets, p.name) ? secrets[p.name] : undefined;
      }
      withholdCredentials(p, values);
      if (method === "secrets.list") { fields(p, ""); return names; }
      if (method === "http.request") return proxy(m, p, { effect, secrets, signal });
      if (method === "borrow") {
        fields(p, "tool args");
        check(typeof p.tool === "string" && m.borrows.includes(p.tool) && record(p.args), "Undeclared or unavailable borrow");
        audit({ plugin: id, borrow: p.tool, caller: call.name });
        check(caller || call.kind === "sources" && host.borrowSource, "No broker context");
        return caller ? await caller.borrow(p.tool, p.args, effect, signal) : await host.borrowSource!(id, p.tool, p.args, signal);
      }
      if (method === "log") {
        fields(p, "message"); check(typeof p.message === "string", "Invalid log");
        audit({ plugin: id, message: p.message.slice(0, 1024) }); return;
      }
      fields(p, method === "kv.list" ? "" : method === "kv.set" ? "key value" : "key");
      const kv = store.active(id)!.kv;
      if (method === "kv.list") return Object.keys(kv);
      const key = p.key;
      check(typeof key === "string" && key && key.length <= 256 && !Object.hasOwn(Object.prototype, key), "Invalid KV key");
      if (method === "kv.get") return Object.hasOwn(kv, key) ? kv[key] : null;
      check(method === "kv.delete" || method === "kv.set" && Object.hasOwn(p, "value"), "Unknown host request");
      store.update(id, sha, v => {
        if (method === "kv.delete") delete v.kv[key];
        else { v.kv[key] = p.value; check(Buffer.byteLength(JSON.stringify(v.kv)) <= m.resources.storageKB * 1024, "KV quota exceeded"); }
      });
    }
    return async (method, params) => {
      const result = await request(method, params);
      signal.throwIfAborted();
      if (method !== "secrets.get") withholdCredentials(result, values);
      return result;
    };
  }
  async function execute(session: Session, version: Version, call: Invoke, caller?: Caller) {
    const m = version.manifest, id = m.id, sha = version.sha, source = call.kind === "sources";
    const tool = m.tools.find(t => t.name === call.name);
    const spec = m.sources.find(s => s.name === call.name);
    if (source) {
      check(spec, "Unknown source " + JSON.stringify(call.name) + " in plugin " + JSON.stringify(id));
      check(!version.sources[call.name]?.paused, "Source is paused");
    } else {
      check(tool, "Unknown tool " + JSON.stringify(call.name) + " in plugin " + JSON.stringify(id));
      validateToolInput(tool, call.args);
    }
    check(!source || !session.polls.has(call.name), "Source poll already in progress");
    const controller = new AbortController();
    const signal = AbortSignal.any([session.stop.signal, controller.signal, ...(caller?.signal ? [caller.signal] : [])]);
    const names = m.secrets.map(s => s.name);
    const secrets = session.secrets;
    const values = Object.values(secrets);
    const safeReason = (cause: unknown) => cause instanceof Error && !containsCredential(cause.message, values)
      ? cause.message : "Plugin invocation failed";
    const trip = async (status: "paused" | "quarantined", reason: string) => {
      store.update(id, sha, v => { v.status = status; });
      audit({ plugin: id, decision: status, reason }); host.changed();
      await host.notify(id, reason);
    };
    if (source) session.polls.add(call.name);
    try {
      signal.throwIfAborted();
      let dir: string;
      try { dir = store.directory(sha); }
      catch { await trip("quarantined", "代码包哈希校验失败"); throw new Error("Package integrity failure"); }
      const effect = source ? "read" : tool!.effect;
      const dispatch = hostRequests(version, call, effect, signal, secrets, caller);
      async function invokeWorker() {
        withholdCredentials(call, values);
        let result: unknown;
        if (adapters.run) result = await adapters.run(dir, m.resources, call, dispatch, signal, values, names);
        else {
          if (!session.worker?.available) session.worker = createWorkerHost(dir, m.resources, values, names);
          result = await session.worker.invoke(call, dispatch, signal);
        }
        signal.throwIfAborted();
        withholdCredentials(result, values);
        return result;
      }
      if (source) {
        const checkpoint = (state: PollerState) => {
          if (store.isActive(id, sha)) store.update(id, sha, v => { v.sources[call.name] = state; });
        };
        const emit = (ref: string, summary: string) => host.emit({
          source: "feed:" + call.name, kind: "new-message", at: Date.now(), author: "external", untrusted: true,
          ref: "feed:" + id + "/" + call.name + "/" + ref, summary,
        });
        const outcome = await runPollBatch(version.sources[call.name] ?? freshProgress(), {
          intervalMs: spec!.minIntervalSeconds * 1000, timeZone, signal, maxInvalid: 3,
          async pull() {
            const result = await invokeWorker();
            return { items: items(result), metadata: result };
          },
          onItem: row => emit(row.id, row.summary),
          coalesce: { after: 20, onRemainder: rows => emit("overflow/" + rows[0]!.id, "另外 " + rows.length + " 条更新") },
          checkpoint,
          classifyError: cause => ({ error: safeReason(cause), invalid: cause instanceof InvalidItems }),
        });
        // stop() drains this session before admitting new work; retain acknowledged deliveries on cancellation.
        if (outcome) checkpoint(outcome.state);
        signal.throwIfAborted();
        check(outcome, "Source poll stopped");
        if (outcome.state.paused) await host.notify(id, "消息来源连续 3 次返回无效数据：" + call.name);
        if (outcome.status === "failed") throw new Error(outcome.state.error ?? "Source poll failed");
        return outcome.status === "success" ? outcome.metadata : undefined;
      }
      const result = await invokeWorker();
      signal.throwIfAborted();
      check(!tool!.outputSchema || matches(tool!.outputSchema, result), "Invalid tool output");
      if (store.active(id)!.failures) store.update(id, sha, v => { v.failures = 0; });
      return result;
    } catch (cause) {
      const reason = safeReason(cause);
      if (!signal.aborted && !(cause instanceof WorkerReset)) {
        audit({ plugin: id, decision: "failure", reason });
        if (!source) {
          store.update(id, sha, v => { v.failures++; });
          if (store.active(id)!.failures >= 5) await trip("paused", "工具连续失败 5 次，插件已暂停");
        }
      }
      throw new Error(reason);
    } finally {
      controller.abort();
      if (source) {
        session.polls.delete(call.name);
        if (scheduled.has(id)) schedule(id);
      }
      host.changed();
    }
  }
  async function invoke(id: string, sha: string, call: Invoke, caller?: Caller): Promise<unknown> {
    const previous = draining.get(id);
    if (previous) await previous;
    check(!closed, "Runtime closed");
    const version = store.active(id);
    check(version && version.sha === sha && version.status === "enabled", "Plugin is not enabled");
    const names = version.manifest.secrets.map(s => s.name);
    const configured = host.secrets(id, names);
    let session = sessions.get(id);
    if (session && names.some(name => session!.secrets[name] !== configured[name])) {
      const reschedule = scheduled.has(id);
      await stop(id);
      if (reschedule && !closed && store.isActive(id, sha)) schedule(id);
      return invoke(id, sha, call, caller);
    }
    session ??= { secrets: { ...configured }, stop: new AbortController(), polls: new Set(), jobs: new Set() };
    sessions.set(id, session);
    const work = execute(session, version, call, caller);
    session.jobs.add(work);
    try { return await work; }
    finally { session.jobs.delete(work); }
  }
  return { store, invoke, schedule, stop,
    async start() {
      for (const p of store.list()) {
        if (p.status !== "enabled" || !p.active) continue;
        try { store.directory(p.active); }
        catch {
          store.update(p.id, p.active, v => { v.status = "quarantined"; });
          audit({ plugin: p.id, decision: "quarantined", reason: "Package integrity failure" });
          await host.notify(p.id, "代码包哈希校验失败");
          host.changed();
          continue;
        }
        schedule(p.id);
      }
    },
    async close() {
      closed = true;
      for (const id of new Set([...scheduled, ...sessions.keys()])) void stop(id);
      await Promise.all(draining.values());
    },
  };
}
