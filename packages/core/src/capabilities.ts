import { obj, str } from "@earendil-works/pi-schema";
import type { ApprovalCall, ApprovalContext } from "./approval-model.ts";
import { defineExtension, defineTool, reply, type Conversation, type ConversationDocToken, type ConversationId, type JsonObject, type ToolRegistration } from "./runtime.ts";

export type Effect = "read" | "write" | "irreversible";
const effects = ["read", "write", "irreversible"] as const;
export function normalizeEffect(value: unknown): Effect {
  if (value === "write-local" || value === "external-send") return "write";
  return value === "read" || value === "write" ? value : "irreversible";
}

export function permitsBorrow(ceiling: string, effect: Effect) {
  const limit = ceiling === "write-local" || ceiling === "external-send" ? "write" : ceiling;
  return effects.indexOf(normalizeEffect(effect)) <= effects.findIndex(e => e === limit);
}
type ActionPolicy = { effect: Effect };
export type ToolAction = ActionPolicy & { capability: string; action: string };
export type Capability = {
  id: string;
  /** Legacy manifest field. Enabled plugin actions are leasable (ADR-0012). */
  mainLeasable?: boolean;
  actions: (ActionPolicy & { name: string })[];
};

export const demoManifests: Capability[] = [
  { id: "calendar", mainLeasable: true, actions: [
    { name: "list", effect: "read" }, { name: "create", effect: "write" },
    { name: "update", effect: "write" },
  ] },
  { id: "notes", mainLeasable: true, actions: [{ name: "read", effect: "read" }] },
  { id: "outbox", mainLeasable: true, actions: [{ name: "send", effect: "write" }] },
];

export type ExternalEvent = {
  source: string; kind: string; summary: string; ref: string; at: number; untrusted: true;
  author?: "external" | "user"; chatId?: string; contact?: string; contactName?: string; text?: string;
};
export type WatchWhere = { channel: "feishu" | "mail"; chatId?: string; contact?: string };
export type WatchSource = {
  authorize(where: WatchWhere): Promise<void>;
  poll(where: WatchWhere, since: number, until: number): Promise<ExternalEvent[]>;
};
export type PluginHost = { watching?(event: ExternalEvent): Promise<boolean>; emit(event: ExternalEvent): Promise<void> };
export type DescribeState = {
  conversationId: ConversationId;
  snapshot<T extends JsonObject>(doc: ConversationDocToken<T>): Promise<Readonly<T> | undefined>;
};
export type AlterPlugin = {
  capability: Capability;
  tools: ToolRegistration[];
  // Return identifying metadata only. Never pass message bodies, snapshots or tool output.
  describe?(call: ApprovalCall, state: DescribeState): ApprovalContext | undefined | Promise<ApprovalContext | undefined>;
  ownMessages?(since: number, until: number): Promise<{ id: string; text: string; at: number }[]>;
  watchSource?: WatchSource;
  agenda?(days?: number): { id: string; title: string; start: number; end: number }[];
  calendarEvents?: {
    get(id: string): { start: number; end: number } | undefined;
    subscribe(listener: (id: string) => void): () => void;
  };
  onTaskEnd?(conversation: Pick<Conversation, "id" | "commit">): Promise<void>;
  start?(host: PluginHost): Promise<() => Promise<void>>;
};

// Demos keep the CLI and offline tests self-contained. A real host turns them off so a
// simulated send is never an alternative to a real one.
export function createCapabilityRegistry(plugins: readonly AlterPlugin[] = [], demos = true) {
  const pluginIds = new Set(plugins.map(plugin => plugin.capability.id));
  const activeDemos = demos ? demoManifests.filter(cap => !pluginIds.has(cap.id)) : [];
  const manifests = [...activeDemos, ...plugins.map(plugin => plugin.capability)];
  const toolActions = new Map<string, ToolAction>();
  const ids = new Set<string>();
  const reserved = new Set(["dispatch_task", "node_sessions", "task_status", "task_message", "task_stop", "enable_tool", "feedback_answer", "digest_source", "finish", "sleep", "watch", "watch_list", "watch_cancel"]);
  for (const capability of manifests) {
    if (ids.has(capability.id)) throw new Error(`Duplicate capability: ${capability.id}`);
    ids.add(capability.id);
    for (const { name: action, ...policy } of capability.actions) {
      const name = `${capability.id}_${action}`;
      if (reserved.has(name) || toolActions.has(name)) throw new Error(`Duplicate tool: ${name}`);
      if (!effects.includes(policy.effect)) throw new Error(`Unsupported effect for ${name}`);
      toolActions.set(name, { capability: capability.id, action, ...policy });
    }
  }
  const descriptions = new Map<string, NonNullable<AlterPlugin["describe"]>>();
  for (const { capability, tools, describe } of plugins) {
    const names = new Set(tools.map(tool => tool.name));
    if (names.size !== tools.length || names.size !== capability.actions.length ||
        tools.some(tool => toolActions.get(tool.name)?.capability !== capability.id)) {
      throw new Error(`Tools must match the actions declared by ${capability.id}`);
    }
    if (describe) for (const name of names) descriptions.set(name, describe);
  }
  async function describe(call: ApprovalCall, state: DescribeState) {
    const lookup = descriptions.get(call.tool);
    if (!lookup) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 5000).unref(); });
      return await Promise.race([lookup(structuredClone(call), state), deadline]);
    } catch { return undefined; }
    finally { clearTimeout(timer); }
  }
  return { manifests, toolActions, activeDemos, describe };
}
export type CapabilityRegistry = ReturnType<typeof createCapabilityRegistry>;
export const { toolActions } = createCapabilityRegistry();

export function createDemoCapabilities(activeDemos = demoManifests) {
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
  ].filter(tool => activeDemos.some(cap => cap.actions.some(action => tool.name === `${cap.id}_${action.name}`)));
  return { calendar, notes, outbox, tools, extension: defineExtension({ name: "alter.capabilities", tools }) };
}
