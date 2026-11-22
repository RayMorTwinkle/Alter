import { randomUUID } from "node:crypto";
import { contentText } from "@earendil-works/pi-ai";
import { inputClock } from "./clock.ts";
import { context, type Conversation, type Cursor, type EntryRecord, type InboxState } from "./runtime.ts";

export type TimelineItem = {
  id: string;
  kind: "user" | "assistant" | "report" | "permission" | "notice";
  text: string;
  at: number;
  taskId?: string;
  model?: string;
  source?: string;
};
export type TranscriptItem =
  | { kind: "user" | "assistant"; text: string; at: number }
  | { kind: "tool_call"; tool: string; arguments: unknown; at: number }
  | { kind: "tool_result"; tool: string; text: string; isError: boolean; at: number };

const inputKind = "alter.user-input";

const defaultClock = inputClock();
// Keep the public submitMessage(main, text) API while each open host supplies the model input prefix.
export const mainInputContext = new WeakMap<Conversation, typeof defaultClock>();

export async function submitMessage(main: Conversation, text: string, source = "web", requestId?: string) {
  const id = requestId ?? randomUUID();
  const { at, prefix } = (mainInputContext.get(main) ?? defaultClock)();
  await main.submit({ type: "input", requestId, content: prefix + "\n" + text, whenBusy: "followUp",
    entry: { kind: inputKind, data: { id, at, text, source } } }, context);
  return id;
}

type InputEntry = Pick<EntryRecord, "kind" | "data">;

function entryData(entry?: InputEntry) {
  const data = entry?.data;
  return data && typeof data === "object" && !Array.isArray(data) ? data : undefined;
}

function surfaceText(entry: InputEntry | undefined, fallback: string) {
  const original = entryData(entry)?.text;
  return (entry?.kind === inputKind || entry?.kind === "alter.task-brief") && typeof original === "string" ? original : fallback;
}

function inputItem(entry: InputEntry | undefined, text: string, id: string, at: number): TimelineItem {
  const data = entryData(entry);
  if (entry?.kind === "alter.task-report" && typeof data?.taskId === "string" && typeof data.at === "number") {
    return { kind: "report", id: `report-${data.taskId}`, taskId: data.taskId, text, at: data.at };
  }
  if (entry?.kind === inputKind || entry?.kind === "alter.cli-input") {
    const source = typeof data?.source === "string" ? data.source : "web";
    if (typeof data?.id === "string" && typeof data.at === "number") {
      return { kind: "user", source, id: data.id, at: data.at, text: surfaceText(entry, text) };
    }
    return { kind: "user", source, text, id, at };
  }
  // Older task and broker submissions have no entry metadata. Only untagged framework
  // inputs take this path; a user can quote either notification verbatim.
  const report = /^task (task-\d+) (finished|failed):/.exec(text);
  if (report) return { kind: "report", id: `report-${report[1]}`, taskId: report[1], text, at };
  const permission = /^permission request (permission-\d+): task (task-\d+) wants /.exec(text);
  if (permission) return { kind: "permission", id: permission[1]!, taskId: permission[2], text, at };
  return { kind: "notice", id, text, at };
}

export function assistantId(taskId: number, at: number) {
  return `assistant-${taskId}-${at}`;
}

export function timelineEntries(entry: EntryRecord): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const [index, msg] of (entry.model ?? []).entries()) {
    const id = `entry-${entry.id}-${index}`;
    const at = msg.timestamp;
    if (msg.role === "user") items.push(inputItem(entry, contentText(msg.content), id, at));
    if (msg.role !== "assistant") continue;
    const text = contentText(msg.content);
    if (text) items.push({ id: entry.byTaskId === undefined ? id : assistantId(entry.byTaskId, at),
      kind: "assistant", text, at: at + (msg.durationMs ?? 0), model: msg.model });
    if (msg.errorMessage) items.push({ kind: "notice", id: `${id}-error`, at, text: `[模型错误] ${msg.model} · ${msg.errorMessage}` });
  }
  return items;
}

export function queuedItem(item: Exclude<InboxState["items"][number], { mode: "write" }>) {
  return inputItem(item.entry, contentText(item.content), `queued-${item.id}`, Date.now());
}

export async function readTranscript(conversation: Conversation): Promise<TranscriptItem[]> {
  const items: TranscriptItem[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ order: "ascending" }, 200, cursor, context);
    for (const entry of page.items) {
      for (const msg of entry.model ?? []) {
        const at = msg.timestamp;
        if (msg.role === "system") continue;
        if (msg.role === "user") {
          items.push({ kind: "user", text: surfaceText(entry, contentText(msg.content)), at });
        } else if (msg.role === "toolResult") {
          items.push({ kind: "tool_result", tool: msg.toolName, text: contentText(msg.content), at, isError: msg.isError });
        } else {
          for (const part of msg.content) {
            if (part.type === "text" && part.text) items.push({ kind: "assistant", text: part.text, at });
            if (part.type === "toolCall") items.push({ kind: "tool_call", tool: part.name, arguments: part.arguments, at });
          }
        }
      }
    }
    cursor = page.next;
  } while (cursor);
  return items;
}
