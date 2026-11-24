import { reply, type AlterApp, type AlterPlugin, type AlterSurface, type PluginDescription, type PluginStatus, type PluginView } from "@alter/core";
import type { FeishuAccount, FeishuPairing } from "@alter/plugin-feishu";
import type { Adapters } from "./adapters.ts";
import type { ExternalPlugins } from "./ext-plugins.ts";
import type { Sources } from "@alter/plugin-sources";
import type { Agenda } from "./server.ts";
import { openSecrets } from "./secrets.ts";
import { HttpError } from "./static.ts";

type Instance = {
  plugin: AlterPlugin; status(probe: boolean): PluginStatus | Promise<PluginStatus>; calendar?: Agenda;
  surface?: AlterSurface & { pairing(): FeishuPairing }; account?: FeishuAccount;
};
export type PluginDefinition = { description: PluginDescription; enabled?: boolean;
  open(env: NodeJS.ProcessEnv, changed: () => void): Instance };

function pluginChanges({ id, settings }: PluginDescription, input: Record<string, unknown>) {
  if (!Object.keys(input).length || Object.keys(input).some(key => key !== "enabled" && key !== "settings") ||
      ("enabled" in input && typeof input.enabled !== "boolean")) throw new HttpError(400, "Invalid plugin patch");
  const changes: Record<string, boolean | string | null> = {};
  if (typeof input.enabled === "boolean") changes[id + ".enabled"] = input.enabled;
  if ("settings" in input) {
    if (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings)) throw new HttpError(400, "Invalid settings");
    for (const [key, v] of Object.entries(input.settings)) {
      const field = settings.find(f => f.key === key);
      if (!field) throw new HttpError(400, "Unknown plugin setting");
      if (v === null) changes[id + "." + key] = null;
      else if (field.type === "toggle" && typeof v === "boolean") changes[id + "." + key] = v;
      else if (field.type !== "toggle" && typeof v === "string" && v.trim() &&
          (field.type !== "select" || field.options?.includes(v))) {
        changes[id + "." + key] = field.type === "secret" ? v : v.trim();
      } else throw new HttpError(400, "Invalid value for " + field.label);
    }
  }
  if (!Object.keys(changes).length) throw new HttpError(400, "Empty plugin patch");
  return changes;
}

export function createPluginManager(app: AlterApp, dir: string, definitions: PluginDefinition[], env = process.env, secrets = openSecrets(dir)) {
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  let closed = false;

  function manage({ description, enabled = true, open }: PluginDefinition) {
    const { id, settings } = description;
    let status: PluginStatus = { state: "connecting" };
    let current: Instance | undefined;
    let stop: (() => Promise<void>) | undefined;
    let pending = Promise.resolve();
    function ordered<T>(fn: () => Promise<T>) {
      const work = pending.then(fn);
      pending = work.then(() => {}, () => {});
      return work;
    }
    function publish(next: PluginStatus) {
      if (JSON.stringify(status) === JSON.stringify(next)) return;
      status = next;
      notify();
    }
    const isEnabled = () => (secrets.get(id + ".enabled") ?? enabled) === true;
    function value(field: typeof settings[number]) {
      const saved = secrets.get(id + "." + field.key);
      if (saved !== undefined) return saved;
      const raw = env[field.key]?.trim();
      if (!raw) return field.default;
      return field.type === "toggle" ? !["off", "false", "0"].includes(raw.toLowerCase()) : raw;
    }
    function view(): PluginView {
      const values = Object.fromEntries(settings.map(field => {
        const v = value(field);
        return [field.key, field.type === "secret" ? { set: !!v } : v ?? null];
      }));
      return { ...description, enabled: isEnabled(), values, status };
    }
    async function refresh(probe: boolean) {
      if (!current) return;
      try { publish(await current.status(probe)); }
      catch { publish({ state: "error", detail: description.name + "状态检查失败，请检查连接和本地配置。" }); }
    }
    async function unload() {
      if (!stop) return;
      current = undefined;
      await stop();
      stop = undefined;
    }
    async function reload(backgroundCheck = false) {
      let stage = "停止旧连接";
      try {
        await unload();
        if (!isEnabled()) {
          if (backgroundCheck) await app.replacePlugin(id);
          publish({ state: "off" });
          return;
        }
        const config: NodeJS.ProcessEnv = {};
        const missing = [];
        for (const field of settings) {
          const v = value(field);
          if (v !== undefined) config[field.key] = String(v);
          if (field.required && (v === undefined || v === "")) missing.push(field.label);
        }
        if (missing.length) { publish({ state: "needs-config", detail: "请填写 " + missing.join("、") }); return; }
        publish({ state: "connecting" });
        stage = "初始化配置";
        let instance: Instance;
        instance = open(config, () => {
          if (!closed && current && current === instance) void ordered(async () => { if (current === instance) await refresh(false); });
        });
        const plugin = instance.plugin;
        const stops: (() => Promise<void>)[] = [];
        const running = new Set<Promise<unknown>>();
        function track<T>(work: Promise<T>) {
          running.add(work);
          return work.finally(() => running.delete(work));
        }
        async function readSource<T>(operation: () => Promise<T>) {
          const changed = "消息渠道已重新配置";
          if (current !== instance) throw new Error(changed);
          const result = await track(operation());
          if (current !== instance) throw new Error(changed);
          return result;
        }
        let registered = false;
        stop = async () => {
          if (registered) { await app.replacePlugin(id, undefined, closed || isEnabled()); registered = false; }
          await Promise.allSettled(running);
          while (stops.length) { await stops.at(-1)!(); stops.pop(); }
        };
        stage = "启动连接";
        if (plugin.start) stops.push(await plugin.start(app.events));
        if (instance.surface) stops.push(await instance.surface.start(app));
        current = instance;
        registered = true;
        const source = plugin.watchSource;
        const ownMessages = plugin.ownMessages;
        await app.replacePlugin(id, { ...plugin,
          ownMessages: ownMessages && ((since, until) => readSource(() => ownMessages(since, until))),
          watchSource: source && {
            authorize: where => readSource(() => source.authorize(where)),
            poll: (where, since, until) => readSource(() => source.poll(where, since, until)),
          },
          tools: plugin.tools.map(tool => ({ ...tool, async execute(...args) {
            if (current !== instance) return reply("插件已停用或配置已更新", true);
            return track(Promise.resolve(tool.execute(...args)));
          } })),
        });
        if (backgroundCheck) void ordered(async () => { if (current === instance) await refresh(true); });
        else await refresh(true);
      } catch (error) {
        const reason = error instanceof Error && /^(Invalid ALTER_MAIL_ADDRESS|ALTER_MAIL_(IMAP|SMTP) requires host:port|ALTER_FEISHU_DOMAIN requires feishu or lark)$/.test(error.message)
          ? error.message : description.name + stage + "失败，请检查配置、连接和数据目录。";
        publish({ state: "error", detail: reason });
        if (stage !== "停止旧连接") await unload().catch(() => {});
      }
    }
    return { view, get current() { return current; }, close: () => ordered(unload), start: () => ordered(() => reload(true)),
      check: () => ordered(async () => { if (current) await refresh(true); else await reload(); return view(); }),
      patch(input: Record<string, unknown>) {
        const changes = pluginChanges(description, input);
        return ordered(async () => {
          if (closed) throw new HttpError(503, "Server shutting down");
          secrets.patch(changes);
          await reload();
          notify();
          return view();
        });
      },
    };
  }
  const plugins = new Map(definitions.map(def => [def.description.id, manage(def)]));
  return {
    active: (id: string) => plugins.get(id)?.current,
    list: () => [...plugins.values()].map(p => p.view()),
    get(id: string) {
      if (closed) throw new HttpError(503, "Server shutting down");
      const plugin = plugins.get(id);
      if (!plugin) throw new HttpError(404, "Unknown plugin");
      return plugin;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => Promise.all([...plugins.values()].map(p => p.start())),
    async close() { closed = true; await Promise.all([...plugins.values()].map(p => p.close())); },
  };
}
export type PluginManager = Omit<ReturnType<typeof createPluginManager>, "get"> & { sources?: Sources; ext?: ExternalPlugins; adapters?: Adapters;
  get(id: string): Pick<ReturnType<ReturnType<typeof createPluginManager>["get"]>, "patch" | "check"> };
