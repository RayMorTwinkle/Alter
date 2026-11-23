import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createProxy, NetworkViolation } from "./http.ts";
import { check, fields, matches, record, type Effect } from "./manifest.ts";
import { run, type Invoke } from "./process.ts";
import { openStore, type Progress, type Version } from "./store.ts";

export { PluginError, check, fields, record, type Effect, type Manifest } from "./manifest.ts";
export type { Version } from "./store.ts";
type Host = {
  secrets(id: string, names: string[]): Record<string, string>;
  emit(event: { source: string; kind: string; at: number; untrusted: true; author: "external"; ref: string; summary: string }): Promise<void>;
  borrowSource?(id: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  notify(id: string, reason: string): Promise<void>;
  changed(): void;
};
type Caller = { signal?: AbortSignal; mark(): Promise<void>; tainted(): Promise<boolean>; borrow(name: string, args: Record<string, unknown>, effect: Effect, signal: AbortSignal): Promise<unknown> };
const fresh = (): Progress => ({ invalid: 0, paused: false, next: 0 });
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
export function openRuntime(data: string, host: Host, adapters: { run?: typeof run; proxy?: typeof createProxy } = {}) {
  const store = openStore(data);
  const audit = (e: object) => appendFileSync(join(store.root, "audit.jsonl"), JSON.stringify({ at: Date.now(), ...e }) + "\n", { mode: 0o600 });
  const proxy = (adapters.proxy ?? createProxy)(audit);
  const running = new Map<string, AbortController>();
  const timers = new Map<string, NodeJS.Timeout>();
  const jobs = new Set<Promise<unknown>>();
  let closed = false;
  function stop(id: string) {
    clearTimeout(timers.get(id)); timers.delete(id);
    running.get(id)?.abort();
  }
  function schedule(id: string) {
    clearTimeout(timers.get(id)); timers.delete(id);
    if (closed) return;
    const version = store.active(id);
    if (version?.status !== "enabled") return;
    const names = version.manifest.secrets.map(s => s.name);
    if (Object.keys(host.secrets(id, names)).length !== names.length) return;
    const due = version.manifest.sources.filter(s => !version.sources[s.name]?.paused)
      .sort((a, b) => (version.sources[a.name]?.next ?? 0) - (version.sources[b.name]?.next ?? 0))[0];
    if (!due) return;
    const delay = Math.max(0, (version.sources[due.name]?.next ?? 0) - Date.now());
    timers.set(id, setTimeout(() => {
      if (running.has(id)) { timers.set(id, setTimeout(() => schedule(id), 250).unref()); return; }
      void invoke(id, version.sha, { kind: "sources", name: due.name, args: null }).catch(() => {}).finally(() => {
        if (!closed && store.list().some(p => p.id === id)) schedule(id);
      });
    }, delay).unref());
  }
  async function execute(id: string, sha: string, call: Invoke, caller?: Caller) {
    check(!closed, "Runtime closed");
    const version = store.active(id);
    check(version && version.sha === sha && version.status === "enabled", "Plugin is not enabled");
    const m = version.manifest, source = call.kind === "sources";
    const tool = m.tools.find(t => t.name === call.name);
    const spec = m.sources.find(s => s.name === call.name);
    check(source ? spec && !version.sources[call.name]?.paused : tool && matches(tool.inputSchema, call.args), "Undeclared call or invalid arguments");
    check(!running.has(id), "Plugin is busy");
    const controller = new AbortController();
    const signal = caller?.signal ? AbortSignal.any([controller.signal, caller.signal]) : controller.signal;
    running.set(id, controller);
    const update = (fn: (v: Version) => void) => { signal.throwIfAborted(); store.update(id, sha, fn); };
    const trip = async (status: "paused" | "quarantined", reason: string) => {
      stop(id);
      store.update(id, sha, v => { v.status = status; });
      audit({ plugin: id, decision: status, reason }); host.changed();
      await host.notify(id, reason);
    };
    const activeRequests = new Set<Promise<unknown>>();
    try {
      signal.throwIfAborted();
      if (source) update(v => { (v.sources[call.name] ??= fresh()).next = Date.now() + spec!.minIntervalSeconds * 1000; });
      let dir: string;
      try { dir = store.directory(sha); }
      catch { await trip("quarantined", "代码包哈希校验失败"); throw new Error("Package integrity failure"); }
      const effect = source ? "read" : tool!.effect;
      const secrets = host.secrets(id, m.secrets.map(s => s.name));
      let observed = false;
      async function request(method: string, p: unknown) {
        signal.throwIfAborted();
        if (method === "http.request") {
          try {
            const response = await proxy(m, p, { effect, secrets, signal, tainted: async () => observed || (await caller?.tainted() ?? false) });
            observed = true; await caller?.mark(); return response;
          } catch (e) {
            if (e instanceof NetworkViolation && !signal.aborted) await trip("quarantined", "越权网络请求：" + e.message);
            throw e;
          }
        }
        if (method === "borrow") {
          fields(p, "tool args");
          check(typeof p.tool === "string" && m.borrows.includes(p.tool) && record(p.args), "Undeclared or unavailable borrow");
          audit({ plugin: id, borrow: p.tool, caller: call.name });
          check(caller || source && host.borrowSource, "No broker context");
          const result = caller ? await caller.borrow(p.tool, p.args, effect, signal) : await host.borrowSource!(id, p.tool, p.args, signal);
          observed = true; return result;
        }
        if (method === "log") {
          fields(p, "message"); check(typeof p.message === "string", "Invalid log");
          audit({ plugin: id, message: p.message.slice(0, 1024) }); return;
        }
        fields(p, method === "kv.list" ? "" : method === "kv.set" ? "key value" : "key");
        const kv = store.active(id)!.kv;
        if (method === "kv.list") { observed = true; await caller?.mark(); return Object.keys(kv); }
        const key = p.key;
        check(typeof key === "string" && key && key.length <= 256 && !Object.hasOwn(Object.prototype, key), "Invalid KV key");
        if (method === "kv.get") { observed = true; await caller?.mark(); return Object.hasOwn(kv, key) ? kv[key] : null; }
        check(method === "kv.delete" || method === "kv.set" && Object.hasOwn(p, "value"), "Unknown host request");
        update(v => {
          if (method === "kv.delete") delete v.kv[key];
          else { v.kv[key] = p.value; check(Buffer.byteLength(JSON.stringify(v.kv)) <= m.resources.storageKB * 1024, "KV quota exceeded"); }
        });
      }
      const result = await (adapters.run ?? run)(dir, m.resources, call, (method, p) => {
        const work = request(method, p);
        activeRequests.add(work);
        return work.finally(() => activeRequests.delete(work));
      }, signal, Object.values(secrets));
      signal.throwIfAborted();
      if (source) {
        const batch = items(result);
        const prev = store.active(id)!.sources[call.name]!;
        const seen = new Set(prev.seen);
        const added = batch.filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; });
        if (prev.seen) {
          for (const row of added.slice(0, 20)) {
            signal.throwIfAborted();
            await host.emit({ source: "feed:" + call.name, kind: "new-message", at: Date.now(), author: "external", untrusted: true,
              ref: "feed:" + id + "/" + call.name + "/" + row.id, summary: row.summary });
          }
          if (added.length > 20) {
            signal.throwIfAborted();
            await host.emit({ source: "feed:" + call.name, kind: "new-message", at: Date.now(), author: "external", untrusted: true,
              ref: "feed:" + id + "/" + call.name + "/overflow/" + added[20]!.id, summary: '另外 ' + (added.length - 20) + ' 条更新' });
          }
        }
        update(v => { v.sources[call.name] = { ...prev, invalid: 0, seen: [...seen].slice(-4096) }; v.failures = 0; });
      } else {
        check(!tool!.outputSchema || matches(tool!.outputSchema, result), "Invalid tool output");
        if (store.active(id)!.failures) update(v => { v.failures = 0; });
      }
      return result;
    } catch (e) {
      if (e instanceof NetworkViolation && !signal.aborted) await trip("quarantined", e.message);
      if (!signal.aborted) {
        update(v => {
          v.failures++;
          if (source) {
            const progress = v.sources[call.name]!;
            progress.invalid = e instanceof InvalidItems ? progress.invalid + 1 : 0;
            if (progress.invalid >= 3) progress.paused = true;
          }
        });
        audit({ plugin: id, decision: "failure", reason: e instanceof Error ? e.message : "Invocation failed" });
        if (store.active(id)!.failures >= 5) await trip("paused", "连续失败 5 次，插件已暂停");
        else if (source && store.active(id)!.sources[call.name]?.paused) await host.notify(id, "消息来源连续 3 次返回无效数据：" + call.name);
      }
      throw e;
    } finally {
      controller.abort();
      await Promise.allSettled(activeRequests);
      running.delete(id); host.changed();
    }
  }
  function invoke(id: string, sha: string, call: Invoke, caller?: Caller) {
    const work = execute(id, sha, call, caller);
    jobs.add(work); return work.finally(() => jobs.delete(work));
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
    async close() { closed = true; for (const p of store.list()) stop(p.id); await Promise.allSettled(jobs); },
  };
}
