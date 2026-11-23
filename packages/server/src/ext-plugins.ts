import { withAbortSignal, permitsBorrow, defineTool, isTainted, markPluginTaint, reply, type AlterApp, type AlterPlugin, type PluginView } from "@alter/core";
import { openRuntime, PluginError, check, fields, record, type Version } from "@alter/plugin-runtime";
import type { openSecrets } from "./secrets.ts";

const capability = (id: string) => "ext-" + id;
const secretKey = (id: string, name: string) => "ext:" + id + ":" + name;
export function externalPlugins(app: AlterApp, dir: string, secrets: ReturnType<typeof openSecrets>) {
  const listeners = new Set<() => void>();
  const registered = new Map<string, string>();
  let queue = Promise.resolve(), closed = false;
  function ordered<T>(fn: () => Promise<T>) {
    const result = queue.then(fn);
    queue = result.then(() => {}, () => {});
    return result;
  }
  function changed() {
    for (const fn of listeners) fn();
    if (!closed) void ordered(reconcile).catch(() => console.error("External plugin registration failed"));
  }
  const runtime = openRuntime(dir, {
    secrets(id, names) {
      return Object.fromEntries(names.flatMap(name => {
        const v = secrets.get(secretKey(id, name));
        return typeof v === "string" && v ? [[name, v]] : [];
      }));
    },
    emit: app.events.emit, changed,
    borrowSource(id, name, args, signal) {
      check(app.capabilities.toolActions.get(name)?.effect === "read", "Sources can only borrow enabled read tools");
      return app.borrowSource(id, name, args as Parameters<typeof app.borrowSource>[2], signal);
    },
    notify: (id, reason) => app.notifications.alert("ext-plugin:" + id, reason),
  });
  const { store } = runtime;
  function plugin(v: Version): AlterPlugin {
    const { id, tools } = v.manifest;
    return { capability: { id: capability(id), mainLeasable: true, actions: tools.map(t => ({ name: t.name, effect: t.effect })) },
      tools: tools.map(t => defineTool({ name: capability(id) + "_" + t.name, description: t.description, parameters: t.inputSchema,
        async execute(args, api, ctx) {
          let seq = 0;
          try {
            const result = await runtime.invoke(id, v.sha, { kind: "tools", name: t.name, args }, {
              signal: ctx.abortSignal, tainted: () => isTainted(api, ctx),
              mark: () => markPluginTaint(api, ctx, capability(id), t.name),
              borrow: async (name, params, effect, signal) => {
                const descriptor = app.capabilities.toolActions.get(name);
                check(descriptor && permitsBorrow(effect, descriptor.effect), "Borrow exceeds calling effect");
                const nested = await api.executeTool(name, params as Parameters<typeof api.executeTool>[1], withAbortSignal(signal, ctx),
                  { key: "ext:" + id + ":" + effect + ":" + ++seq, progress: false });
                check(!nested.isError, "Borrowed tool failed or was denied");
                return nested.structuredOutput ?? null;
              },
            });
            return { ...reply(JSON.stringify(result)), details: { untrusted: true } };
          } catch (e) { return reply(e instanceof Error ? e.message : "Plugin failed", true); }
        },
      })) };
  }
  async function reconcile() {
    const enabled = new Map(store.list().filter(p => p.status === "enabled" && p.manifest.secrets.every(s => secrets.get(secretKey(p.id, s.name)))).map(p => [p.id, p.active!]));
    for (const [id] of registered) if (!enabled.has(id)) {
      await app.replacePlugin(capability(id)); registered.delete(id);
    }
    for (const [id, sha] of enabled) if (registered.get(id) !== sha) {
      await app.replacePlugin(capability(id), plugin(store.active(id)!)); registered.set(id, sha);
    }
  }
  function view(id: string): PluginView {
    const v = store.view(id), m = v.manifest;
    const missing = m.secrets.some(s => !secrets.get(secretKey(id, s.name)));
    return { id: capability(id), name: m.displayName, enabled: v.status === "enabled",
      provides: { channels: [], capabilities: m.tools.map(t => capability(id) + "_" + t.name), sources: m.sources.map(s => s.name) },
      settings: m.secrets.map(s => ({ key: s.name, label: s.name, type: "secret", required: true, help: s.purpose })),
      values: Object.fromEntries(m.secrets.map(s => [s.name, { set: !!secrets.get(secretKey(id, s.name)) }])),
      status: { state: v.status === "enabled" ? missing ? "needs-config" : "ok" : v.status === "disabled" ? "off" : "error", detail: v.status } };
  }
  function toggle(id: string, enable: boolean) {
    const v = store.active(id);
    check(v && v.status !== "quarantined", "No approved, non-quarantined version");
    store.update(id, v.sha, x => {
      x.status = enable ? "enabled" : "disabled";
      if (enable) { x.failures = 0; for (const s of Object.values(x.sources)) { s.invalid = 0; s.paused = false; } }
    });
  }
  return {
    list: store.list, views: () => store.list().filter(p => p.active).map(p => view(p.id)),
    subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb); },
    start: () => ordered(async () => { await runtime.start(); await reconcile(); }),
    async close() {
      if (closed) return;
      closed = true;
      await runtime.close(); await queue;
      for (const id of registered.keys()) await app.replacePlugin(capability(id));
      registered.clear();
    },
    async install(input: Record<string, unknown>) {
      fields(input, "path"); check(typeof input.path === "string", "Expected a package directory");
      try {
        const p = store.propose(input.path); changed(); return p;
      } catch (e) {
        if (e instanceof PluginError) throw e;
        throw new PluginError("Cannot read a valid plugin package");
      }
    },
    action(id: string, action: string, input: Record<string, unknown>) {
      return ordered(async () => {
        check(!closed, "Server shutting down");
        fields(input, action === "approve" || action === "rollback" ? "sha" : "");
        if (action === "approve") store.approve(id, input.sha);
        else if (action === "reject") store.reject(id);
        else if (action === "rollback") store.rollback(id, input.sha);
        else if (action === "enable" || action === "disable") toggle(id, action === "enable");
        else if (action === "delete") {
          const e = store.view(id);
          const keys = new Set(store.secretNames(id));
          store.remove(id);
          if (e.active) secrets.patch(Object.fromEntries([...keys].map(n => [secretKey(id, n), null])));
        } else throw new PluginError("Unknown plugin action", 404);
        if (action !== "reject") runtime.stop(id);
        await reconcile();
        if (store.list().some(p => p.id === id)) runtime.schedule(id);
        changed();
      });
    },
    get(id: string) {
      const key = id.slice(4);
      return { check: async () => view(key), patch: (input: Record<string, unknown>) => ordered(async () => {
          fields(input, "settings enabled");
          const v = store.active(key); check(v, "No approved version");
          if ("settings" in input) {
            const s = input.settings;
            check(record(s) && Object.entries(s).every(([k, value]) => v.manifest.secrets.some(f => f.name === k) &&
              (value === null || typeof value === "string" && value.length <= 8192 && /^[\x20-\x7e]+$/.test(value))), "Invalid secret settings");
          }
          if ("enabled" in input) { check(typeof input.enabled === "boolean", "Invalid enabled flag"); toggle(key, input.enabled); }
          if (record(input.settings)) secrets.patch(Object.fromEntries(Object.entries(input.settings).map(([k, val]) => [secretKey(key, k), val as string | null])));
          runtime.stop(key); await reconcile(); runtime.schedule(key); changed(); return view(key);
        }) };
    },
  };
}
export type ExternalPlugins = ReturnType<typeof externalPlugins>;
