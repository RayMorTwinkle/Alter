import { obj, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, reply, type ToolRegistration } from "./runtime.ts";

export type Effect = "read" | "write-local" | "external-send" | "irreversible" | "unknown";
export type Capability = {
  id: string;
  mainLeasable: boolean;
  actions: { name: string; effect: Effect }[];
};

export const demoManifests: Capability[] = [
  { id: "calendar", mainLeasable: true, actions: [
    { name: "list", effect: "read" }, { name: "create", effect: "write-local" },
    { name: "update", effect: "write-local" },
  ] },
  { id: "notes", mainLeasable: false, actions: [{ name: "read", effect: "read" }] },
  { id: "outbox", mainLeasable: false, actions: [{ name: "send", effect: "external-send" }] },
];

export type ExternalEvent = {
  source: string; kind: string; summary: string; ref: string; at: number; untrusted: true;
};
export type PluginHost = { emit(event: ExternalEvent): Promise<void> };
export type AlterPlugin = {
  capability: Capability;
  tools: ToolRegistration[];
  start?(host: PluginHost): Promise<() => Promise<void>>;
};

export function createCapabilityRegistry(plugins: readonly AlterPlugin[] = []) {
  const manifests = [...demoManifests, ...plugins.map(plugin => plugin.capability)];
  const toolActions = new Map<string, { capability: string; action: string; effect: Effect }>();
  const ids = new Set<string>();
  const reserved = new Set(["dispatch_task", "task_status", "answer_permission_request", "enable_tool", "request_capability", "finish"]);
  for (const capability of manifests) {
    if (ids.has(capability.id)) throw new Error(`Duplicate capability: ${capability.id}`);
    ids.add(capability.id);
    for (const { name: action, effect } of capability.actions) {
      const name = `${capability.id}_${action}`;
      if (reserved.has(name) || toolActions.has(name)) throw new Error(`Duplicate tool: ${name}`);
      toolActions.set(name, { capability: capability.id, action, effect });
    }
  }
  for (const { capability, tools } of plugins) {
    const names = new Set(tools.map(tool => tool.name));
    if (names.size !== tools.length || names.size !== capability.actions.length ||
        tools.some(tool => toolActions.get(tool.name)?.capability !== capability.id)) {
      throw new Error(`Tools must match the actions declared by ${capability.id}`);
    }
  }
  return { manifests, toolActions };
}
export type CapabilityRegistry = ReturnType<typeof createCapabilityRegistry>;
export const { toolActions } = createCapabilityRegistry();

export function createDemoCapabilities() {
  const calendar = new Map<string, string>();
  const notes = new Map<string, string>([["welcome", "Remember the planning meeting."]]);
  const outbox: string[] = [];
  const tools = [
    defineTool({
      name: "calendar_list", description: "List calendar events with their IDs.", parameters: obj({}),
      replay: "safe", execute: async () => reply(JSON.stringify(Object.fromEntries(calendar))),
    }),
    defineTool({
      name: "calendar_create", description: "Create an event and return its ID.", parameters: obj({ title: str() }),
      execute: async ({ title }, api) => {
        const id = `event-${api.taskId}`;
        calendar.set(id, title);
        return reply(id);
      },
    }),
    defineTool({
      name: "calendar_update", description: "Rename an existing event.", parameters: obj({ id: str(), title: str() }),
      execute: async ({ id, title }) => {
        if (!calendar.has(id)) return reply("Unknown event", true);
        calendar.set(id, title);
        return reply(id);
      },
    }),
    defineTool({
      name: "notes_read", description: "Read a note by ID.", parameters: obj({ id: str() }), replay: "safe",
      execute: async ({ id }) => reply(notes.get(id) ?? "Unknown note", !notes.has(id)),
    }),
    defineTool({
      name: "outbox_send", description: "Record a message in the demo outbox.", parameters: obj({ message: str() }),
      execute: async ({ message }) => {
        outbox.push(message);
        return reply("Recorded in outbox");
      },
    }),
  ];
  return { calendar, notes, outbox, tools, extension: defineExtension({ name: "alter.capabilities", tools }) };
}
