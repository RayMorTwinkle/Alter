import type { PluginWebExtensions } from "@alter/core";
import { calendarWeb, type Agenda } from "@alter/plugin-calendar";
import { feishuSetupWeb, feishuWeb, type FeishuAccount, type FeishuPairing } from "@alter/plugin-feishu";
import { sourcesWeb } from "@alter/plugin-sources";

export type { Agenda };
export type LegacyPluginOptions = { calendar?: Agenda; feishu?: { pairing(): FeishuPairing }; feishuAccount?: FeishuAccount };

export function legacyPluginWeb(options: LegacyPluginOptions, standalone: boolean): PluginWebExtensions[] {
  const web = [];
  if (options.calendar) web.push(calendarWeb(options.calendar));
  if (options.feishu || options.feishuAccount) web.push(feishuWeb(options.feishu, options.feishuAccount));
  if (standalone) web.push(feishuSetupWeb(), sourcesWeb());
  return web;
}
