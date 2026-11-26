import type { PluginDescription, PluginStatus, PluginWebExtensions } from "@alter/core";
import { createCalendarPlugin } from "./index.ts";

export const calendarDescription: PluginDescription = { id: "calendar", name: "日历",
  provides: { channels: [], capabilities: ["calendar"], sources: [] }, settings: [] };

export type Agenda = { timeZone: string; agenda(): unknown[]; subscribe(listener: () => void): () => void };

export function calendarWeb(calendar: Agenda): PluginWebExtensions {
  const snapshot = () => ({ timeZone: calendar.timeZone, events: calendar.agenda() });
  return { routes: [{ method: "GET", path: "/api/calendar", handle: ({ json }) => json(200, snapshot()) }],
    sse: [{ event: "calendar", onConnect: false, snapshot, subscribe: cb => calendar.subscribe(cb), cleared: { timeZone: calendar.timeZone, events: [] } }] };
}

export function calendarInstance(dataDir: string, timeZone: string) {
  const plugin = createCalendarPlugin({ dataDir, timeZone });
  return { plugin, ...calendarWeb(plugin), status: (): PluginStatus => ({ state: "ok" }) };
}
