import type { Effect } from "@alter/core";

type Strings = Record<string, string>;
export type McpConfig = { transport: "stdio"; command: string; args?: string[]; env?: Strings }
  | { transport: "http"; url: string; headers?: Strings };
export type CliConfig = { command: string; args?: string[]; env?: Strings; cwd?: string; help?: string; timeoutMs?: number };
export type HttpConfig = { spec: string | Record<string, unknown>; baseUrl?: string; headers?: Strings };
export type AdapterDefinition = { kind: "mcp"; config: McpConfig } | { kind: "cli"; config: CliConfig } | { kind: "http"; config: HttpConfig };
export type AdapterEffect = Effect;
export type AdapterKind = AdapterDefinition["kind"];
export type AdapterConfig = AdapterDefinition["config"];
export type AdapterCreate = AdapterDefinition & { id: string; name: string; secrets?: Strings };
export type AdapterPatch = { name?: string; enabled?: boolean; config?: AdapterConfig; effects?: Record<string, Effect>; secrets?: Strings };
export type AdapterTool = { name: string; description: string; inputSchema: Record<string, unknown>; defaultEffect: Effect };
export type AdapterEntry = AdapterDefinition & { id: string; name: string; enabled: boolean; effects: Record<string, Effect>; tools: AdapterTool[] };
export type AdapterToolView = AdapterTool & { effect: Effect };
export type AdapterStatus = { state: "off" | "connecting" | "ok" | "error"; detail?: string };
export type AdapterView = Omit<AdapterEntry, "kind" | "config" | "tools"> & AdapterDefinition & {
  capabilityId: string; status: AdapterStatus; secretNames: string[]; tools: AdapterToolView[];
};

export type Result = { output: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError: boolean };
export type DiscoveredTool = AdapterTool & { call(args: Record<string, unknown>, signal: AbortSignal): Promise<Result> };
export type Connection = { tools: DiscoveredTool[]; close?(): Promise<void> };
export type Expand = (value: string) => string;

export function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
export function strings(v: unknown): v is Strings {
  return record(v) && Object.values(v).every(value => typeof value === "string");
}
export function expandMap(map: Strings | undefined, expand: Expand) {
  return Object.fromEntries(Object.entries(map ?? {}).map(([key, value]) => [key, expand(value)]));
}
