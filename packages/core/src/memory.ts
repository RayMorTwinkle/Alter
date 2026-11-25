import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { arr, compile, nullable, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";
import { calendarTime } from "./calendar-time.ts";
import type { Capability } from "./capabilities.ts";
import { defaultTimeZone } from "./clock.ts";
import { defineTool, LiveDoc, reply, type ToolExecutionApi, type Context } from "./runtime.ts";
import { due, entryType, MemoryInputError, migratedType, nonempty, openMemoryStore, patchFields, sentence, status,
  type EntryInput, type MemoryEntry, type Operation } from "./memory-store.ts";
export { MemoryInputError, MemoryConflict, type MemoryEntry, type MemoryChange } from "./memory-store.ts";

const kind = oneOf(["profile", "goal", "fact"]);
const saveSchema = obj({ kind, text: nonempty, due: opt(due) });
const validSave = compile(saveSchema);
const legacyPatch = { text: opt(nonempty), status: opt(status), due: opt(nullable(due)) };
const patch = compile(obj({ ...patchFields, ...legacyPatch }));
const dueText = str({ description: "ISO date (end of local day) or date-time. An offset-free time uses the user's time zone." });
const id = str({ minLength: 1 });
export const memoryWriteGuidance = "title 用 20 字以内的短标题概括主题，不要照抄正文；body 写完整内容。" +
  "type 按内容选择：user 记用户是谁（身份、背景、作息、兴趣），preference 记希望 Alter 怎么做（回复风格、渠道、做事方式），" +
  "goal 记要达成的事，有期限就填 ISO 日期或时间 dueAt；reference 记账号、地址、资源。一句话里有多件事时拆成多条，分别调用 memory_write。" +
  "目标完成时用 modify 将 status 设为 done，重新开始时设为 active。";
export type MemoryItem = {
  id: string; kind: Static<typeof kind>; text: string; due?: number; status: Static<typeof status>;
  createdAt: number; updatedAt: number;
};
function legacy(e: MemoryEntry): MemoryItem {
  return { id: e.id, kind: e.type === "goal" ? "goal" : e.type === "reference" ? "fact" : "profile", text: e.body,
    ...(e.dueAt !== undefined && { due: e.dueAt }), status: e.status, createdAt: e.createdAt, updatedAt: e.updatedAt };
}
const capability: Capability = { id: "memory", mainLeasable: true, actions: [
  { name: "read", effect: "read" }, { name: "search", effect: "read" }, { name: "write", effect: "write" },
  { name: "delete", effect: "write" },
] };

async function messageSource(api: ToolExecutionApi, ctx: Context) {
  if (!api.commit) return;
  return api.commit(async tx => {
    const first = (await tx.doc(LiveDoc, api.conversationId)).run?.first;
    if (first === undefined) return;
    const entry = await tx.entry(first);
    if (entry?.kind !== "alter.user-input") return;
    const data = entry.data;
    if (data && typeof data === "object" && !Array.isArray(data) && typeof data.id === "string") return data.id;
  }, ctx);
}

export function createMemory(dataDir?: string, now = Date.now, timeZone = defaultTimeZone) {
  let store: ReturnType<typeof openMemoryStore>;
  const time = calendarTime(timeZone);
  function deadline(value: string) {
    try {
      const { ms } = time.parse(value);
      return value.length === 10 ? time.midnight(ms, 1) : ms;
    } catch (error) { throw new MemoryInputError((error as Error).message); }
  }
  function save(args: Static<typeof saveSchema>, source?: string) {
    if (!validSave.check(args)) throw new MemoryInputError("Expected a kind, non-empty text and optional deadline in milliseconds");
    return store.apply([{ op: "add", entry: { type: migratedType[args.kind], title: sentence(args.text, 30), body: args.text,
      ...(source && { source }), ...(args.due !== undefined && { dueAt: args.due }) } }])[0]!.ids[0]!;
  }
  function update(id: string, changes: unknown) {
    if (!patch.check(changes) || !Object.keys(changes).length) throw new MemoryInputError("Expected an entry patch");
    const e = store.read(id);
    if (!e || e.supersededBy) return false;
    const { due, text, ...fields } = changes;
    if ((due !== undefined && fields.dueAt !== undefined) || (text !== undefined && fields.body !== undefined)) throw new MemoryInputError("Duplicate patch fields");
    store.apply([{ op: "modify", id, patch: { ...fields, ...(text && { body: text, ...(!fields.title && e.title === sentence(e.body, 30) && { title: sentence(text, 30) }) }),
      ...(due !== undefined && { dueAt: due }) } }]);
    return true;
  }
  function remove(id: string) {
    const e = store.read(id);
    if (!e || e.supersededBy) return false;
    store.apply([{ op: "delete", id }]);
    return true;
  }
  function list() { store.refresh(); return store.entries().map(legacy); }
  function search(query: string, filter?: MemoryItem["kind"]) {
    return store.search(query).map(legacy).filter(e => !filter || filter === e.kind);
  }
  function summary() {
    let result = "";
    for (const row of list()) {
      if (row.kind === "fact" || (row.kind === "goal" && row.status === "done")) continue;
      const label = row.kind === "profile" ? "画像" : row.status === "pending" ? "目标（已过期，待确认）" : "目标";
      const due = row.due === undefined ? "" : `（期限 ${time.describe(row.due).label}）`;
      result += (result ? "\n" : "[记忆摘要]\n") + label + due + "：" + row.text;
      if (result.length >= 1200) return result.slice(0, 1200).replace(/[\uD800-\uDBFF]$/, "");
    }
    return result;
  }
  return {
    capability, save, update, delete: remove, search, summary, list, deadline,
    get store() { return store; },
    subscribe(listener: (items: MemoryItem[]) => void) {
      const notify = () => listener(list());
      store.listeners.add(notify);
      return () => store.listeners.delete(notify);
    },
    tools: [
      defineTool({ name: "memory_read", description: "Open memory entries by id or ids, including superseded history.",
        parameters: obj({ id: opt(id), ids: opt(arr(id)) }), replay: "safe",
        execute: async args => {
          if ((args.id !== undefined) === (args.ids !== undefined) || args.ids?.length === 0) return reply("Expected id or ids", true);
          store.refresh();
          const found = (args.ids ?? [args.id!]).map(store.read);
          return found.some(e => !e) ? reply("Unknown memory", true) : reply(JSON.stringify(args.ids ? found : found[0]));
        } }),
      defineTool({ name: "memory_search", description: "Search memory titles and bodies by literal substring.",
        parameters: obj({ query: nonempty, kind: opt(kind) }), replay: "safe",
        execute: async args => reply(JSON.stringify(store.search(args.query).filter(e => !args.kind || legacy(e).kind === args.kind).map(e => ({ ...legacy(e), ...e })))) }),
      defineTool({ name: "memory_write", description: "op 默认 add 新增；modify 提供 id 和要改的字段；supersede 提供旧 id 和完整新条目，旧条目保留在历史中。" + memoryWriteGuidance,
        parameters: obj({ op: opt(oneOf(["add", "modify", "supersede"])), id: opt(id), title: opt(str({ pattern: "\\S", maxLength: 20 })), type: opt(entryType), body: opt(nonempty),
          dueAt: opt(nullable(dueText)), status: opt(oneOf(["active", "done"])) }),
        execute: async ({ op = "add", id, dueAt, ...fields }, api, ctx) => {
          const source = await messageSource(api, ctx);
          const data = { ...fields, ...(source && { source }), ...(dueAt !== undefined && { dueAt: dueAt === null ? null : deadline(dueAt) }) };
          if (op === "modify") {
            if (!id || (!Object.keys(fields).length && dueAt === undefined)) return reply("Expected id and changes", true);
            if (fields.status !== undefined && (fields.type ?? store.read(id)?.type) !== "goal") return reply("Only goals have a writable status", true);
            return update(id, data) ? reply(id) : reply("Unknown memory", true);
          }
          if ((op === "supersede") !== !!id || !data.title || !data.type || !data.body) return reply("Expected title, type, body and old id only for supersede", true);
          if (fields.status !== undefined && data.type !== "goal") return reply("Only goals have a writable status", true);
          const entry: EntryInput = { ...fields, ...(source && { source }), title: data.title, type: data.type, body: data.body, ...(data.dueAt != null && { dueAt: data.dueAt }) };
          const action: Operation = op === "add" ? { op, entry } : { op, ids: [id!], entry };
          return reply(store.apply([action])[0]!.ids.at(-1)!);
        } }),
      defineTool({ name: "memory_delete", description: "Delete a memory by ID.",
        parameters: obj({ id }), execute: async ({ id }) => remove(id) ? reply(id) : reply("Unknown memory", true) }),
    ],
    async start() {
      if (dataDir) await mkdir(dataDir, { recursive: true });
      store = openMemoryStore(dataDir ? join(dataDir, "memory.sqlite") : ":memory:", now, timeZone);
      return async () => store.close();
    },
  };
}
