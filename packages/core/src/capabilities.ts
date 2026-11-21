import { obj, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, reply } from "./runtime.ts";

export type Effect = "read" | "write-local" | "external-send" | "irreversible" | "unknown";
export type Capability = {
  id: string;
  mainLeasable: boolean;
  actions: { name: string; effect: Effect }[];
};

export const manifests: Capability[] = [
  { id: "calendar", mainLeasable: true, actions: [
    { name: "list", effect: "read" }, { name: "create", effect: "write-local" },
    { name: "update", effect: "write-local" },
  ] },
  { id: "notes", mainLeasable: false, actions: [{ name: "read", effect: "read" }] },
  { id: "outbox", mainLeasable: false, actions: [{ name: "send", effect: "external-send" }] },
];

export const toolActions = new Map<string, { capability: string; action: string; effect: Effect }>(manifests.flatMap(capability =>
  capability.actions.map(action => [
    `${capability.id}_${action.name}`, { capability: capability.id, action: action.name, effect: action.effect },
  ] as const),
));

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
