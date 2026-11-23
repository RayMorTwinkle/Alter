import type { AlterApp } from "@alter/core";
import { browserDescription, browserInstance } from "@alter/plugin-browser";
import { calendarDescription, calendarInstance } from "@alter/plugin-calendar";
import { feishuDescription, feishuInstance } from "@alter/plugin-feishu";
import { mailDescription, mailInstance } from "@alter/plugin-mail";
import { openSources } from "@alter/plugin-sources";
import { openSecrets } from "./secrets.ts";
import { createPluginManager } from "./plugin-manager.ts";

export function installedPlugins(app: AlterApp, dataDir: string, env = process.env, options: Parameters<typeof openSources>[2] = {}) {
  const secrets = openSecrets(dataDir);
  const sources = openSources(secrets, app.timeZone, { now: app.now, ...options });
  const manager = createPluginManager(app, dataDir, [
    { description: calendarDescription, open: () => calendarInstance(dataDir, app.timeZone) },
    { description: feishuDescription, open: (config, changed) => feishuInstance(config, dataDir, changed, env) },
    { description: mailDescription, open: mailInstance },
    { description: browserDescription, enabled: env.ALTER_BROWSER !== "off", open: () => browserInstance() },
    { description: sources.description, open: () => ({ plugin: sources.plugin, status: () => ({ state: "ok" }) }) },
  ], env, secrets);
  return { ...manager, sources };
}
