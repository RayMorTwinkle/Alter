import { hostPolicy } from "./role-policy.ts";
import type { AlterApp } from "@alter/core";
import { browserDescription, browserInstance } from "@alter/plugin-browser";
import { calendarDescription, calendarInstance } from "@alter/plugin-calendar";
import { feishuDescription, feishuInstance, feishuSetupWeb } from "@alter/plugin-feishu";
import { mailDescription, mailInstance } from "@alter/plugin-mail";
import { openSources, sourcesWeb } from "@alter/plugin-sources";
import { openAdapters } from "./adapters.ts";
import { externalPlugins } from "./ext-plugins.ts";
import { openSecrets } from "./secrets.ts";
import { createPluginManager, type PluginDefinition, type PluginManager } from "./plugin-manager.ts";

export type WebPluginManager = PluginManager & { ext?: ReturnType<typeof externalPlugins>; adapters?: ReturnType<typeof openAdapters> };

export function installedPlugins(app: AlterApp, dataDir: string, env = process.env, options: Parameters<typeof openSources>[2] = {}) {
  const { restricted, allowsPlugin } = hostPolicy(env);
  const secrets = openSecrets(dataDir);
  const sources = openSources(secrets, app.timeZone, { now: app.now, ...options });
  const definitions: PluginDefinition[] = [
    { description: calendarDescription, open: () => calendarInstance(dataDir, app.timeZone) },
    { description: feishuDescription, setupWeb: feishuSetupWeb, open: (config, changed) => feishuInstance(config, dataDir, changed, env) },
    { description: mailDescription, open: mailInstance },
    { description: browserDescription, enabled: env.ALTER_BROWSER !== "off", open: () => browserInstance() },
    { description: sources.description, setupWeb: () => sourcesWeb(sources), open: () => ({ plugin: sources.plugin, status: () => ({ state: "ok" }) }) },
  ];
  const manager = createPluginManager(app, dataDir, definitions.filter(def => allowsPlugin(def.description.id)), env, secrets);
  const ext = restricted ? undefined : externalPlugins(app, dataDir, secrets);
  const adapters = restricted ? undefined : openAdapters(app, dataDir, secrets);
  return { ...manager, sources, ext, adapters,
    subscribe(fn: () => void) {
      const offManager = manager.subscribe(fn), offAdapters = adapters?.subscribe(fn);
      const offSources = sources.subscribe(namesChanged => { if (namesChanged) fn(); });
      return () => { offManager(); offAdapters?.(); offSources(); };
    },
    list: () => [...manager.list(), ...ext?.views() ?? [], ...adapters?.views() ?? []],
    get: (id: string) => ext && id.startsWith("ext-") ? ext.get(id) : adapters && /^(mcp|cli|api)-/.test(id) ? adapters.getPlugin(id) : manager.get(id),
    async start() { const result = await manager.start(); await ext?.start(); await adapters?.start(); await app.finishPluginRegistration(); return result; },
    async close() { await adapters?.close(); await ext?.close(); await manager.close(); },
  };
}
