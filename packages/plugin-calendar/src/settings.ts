import type { PluginDescription, PluginStatus } from "@alter/core";
import { createCalendarPlugin } from "./index.ts";

export const calendarDescription: PluginDescription = { id: "calendar", name: "日历",
  provides: { channels: [], capabilities: ["calendar"], sources: [] }, settings: [] };

export function calendarInstance(dataDir: string, timeZone: string) {
  const calendar = createCalendarPlugin({ dataDir, timeZone });
  return { plugin: calendar, calendar, status: (): PluginStatus => ({ state: "ok" }) };
}
