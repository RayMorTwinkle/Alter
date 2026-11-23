export type PluginField = {
  key: string; label: string; type: "text" | "secret" | "toggle" | "select";
  required: boolean; help: string; options?: string[]; default?: string | boolean;
};
export type PluginDescription = {
  id: string; name: string; provides: { channels: string[]; capabilities: string[]; sources: string[] }; settings: PluginField[];
};
export type PluginCheck = { id: string; label: string; ok: boolean; detail?: string };
export type PluginStatus = { state: "off" | "needs-config" | "connecting" | "ok" | "error"; detail?: string; checks?: PluginCheck[] };
export type PluginView = PluginDescription & {
  enabled: boolean; values: Record<string, string | boolean | null | { set: boolean }>; status: PluginStatus;
};
