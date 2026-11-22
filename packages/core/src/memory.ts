import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { compile, int, nullable, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";
import type { Capability } from "./capabilities.ts";
import { defineTool, reply } from "./runtime.ts";

const kind = oneOf(["profile", "goal", "fact"]);
const status = oneOf(["active", "done", "pending"]);
const text = str({ pattern: "\\S" });
const due = int({ description: "Goal deadline in Unix milliseconds", minimum: -8.64e15, maximum: 8.64e15 });
const saveSchema = obj({ kind, text, due: opt(due) });
const validSave = compile(saveSchema);
const patchFields = { text: opt(text), status: opt(status), due: opt(nullable(due)) };
const patch = compile(obj(patchFields));
const id = str({ minLength: 1 });

export type MemoryItem = {
  id: string; kind: Static<typeof kind>; text: string; due?: number; status: Static<typeof status>;
  createdAt: number; updatedAt: number;
};
type Row = Omit<MemoryItem, "id" | "due"> & { id: number; due: number | null };
export class MemoryInputError extends Error {}

const capability: Capability = { id: "memory", mainLeasable: true, actions: [
  { name: "search", effect: "read" }, { name: "save", effect: "write-local", guarded: true },
  { name: "update", effect: "write-local", guarded: true }, { name: "delete", effect: "write-local", guarded: true },
] };

export function createMemory(dataDir?: string, now = Date.now) {
  let db: DatabaseSync;
  const listeners = new Set<(items: MemoryItem[]) => void>();
  function select(where = "1", ...params: SQLInputValue[]): MemoryItem[] {
    const rows = db.prepare(`SELECT * FROM memory WHERE ${where} ORDER BY updatedAt DESC, id DESC`).all(...params) as Row[];
    return rows.map(({ id, due, ...item }) => ({ ...item, id: String(id), ...(due !== null && { due }) }));
  }
  function refresh(changed = false) {
    if (changed && !listeners.size) return;
    const at = now();
    const expired = db.prepare("UPDATE memory SET status='pending', updatedAt=? WHERE kind='goal' AND status='active' AND due < ?").run(at, at);
    if ((changed || expired.changes) && listeners.size) {
      const items = select();
      for (const listener of listeners) listener(items);
    }
  }
  function search(query: string, filter?: MemoryItem["kind"]) {
    refresh();
    // MATCH treats quoted input as a literal phrase. Trigrams cannot match one or two code points.
    const indexed = [...query].length >= 3;
    const condition = indexed ? "id IN (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?)" : "text LIKE ? ESCAPE '!'";
    const term = indexed ? '"' + query.replaceAll('"', '""') + '"' : "%" + query.replace(/[!%_]/g, "!$&") + "%";
    return filter ? select(condition + " AND kind=?", term, filter) : select(condition, term);
  }
  function save(args: Static<typeof saveSchema>) {
    if (!validSave.check(args)) throw new MemoryInputError("Expected a kind, non-empty text and optional deadline in milliseconds");
    if (args.due !== undefined && args.kind !== "goal") throw new MemoryInputError("Only goals have deadlines");
    const at = now();
    const result = db.prepare("INSERT INTO memory(kind,text,due,status,createdAt,updatedAt) VALUES (?,?,?,'active',?,?)")
      .run(args.kind, args.text, args.due ?? null, at, at);
    refresh(true);
    return String(result.lastInsertRowid);
  }
  function update(id: string, changes: unknown) {
    if (!patch.check(changes) || !Object.keys(changes).length) throw new MemoryInputError("Expected text, status or due");
    if (changes.due != null) {
      const row = db.prepare("SELECT kind FROM memory WHERE id=?").get(id);
      if (row && row.kind !== "goal") throw new MemoryInputError("Only goals have deadlines");
    }
    const result = db.prepare(`UPDATE memory SET text=coalesce(?,text), status=coalesce(?,status),
      due=CASE WHEN ? THEN ? ELSE due END, updatedAt=? WHERE id=?`)
      .run(changes.text ?? null, changes.status ?? null, Number(changes.due !== undefined), changes.due ?? null, now(), id);
    if (result.changes) refresh(true);
    return !!result.changes;
  }
  function remove(id: string) {
    const result = db.prepare("DELETE FROM memory WHERE id=?").run(id);
    if (result.changes) refresh(true);
    return !!result.changes;
  }
  function summary() {
    refresh();
    let result = "";
    for (const row of db.prepare(`SELECT kind,status,due,substr(text,1,1200) AS text FROM memory
      WHERE kind='profile' OR (kind='goal' AND status IN ('active','pending'))
      ORDER BY updatedAt DESC, id DESC`).iterate()) {
      const label = row.kind === "profile" ? "画像" : row.status === "pending" ? "目标（已过期，待确认）" : "目标";
      const deadline = typeof row.due === "number" ? `（期限 ${new Date(row.due).toISOString()}）` : "";
      result += (result ? "\n" : "[记忆摘要]\n") + label + deadline + "：" + row.text;
      if (result.length >= 1200) return result.slice(0, 1200).replace(/[\uD800-\uDBFF]$/, "");
    }
    return result;
  }

  return {
    capability, save, update, delete: remove, search, summary,
    list() { refresh(); return select(); },
    subscribe(listener: (items: MemoryItem[]) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tools: [
      defineTool({ name: "memory_search", description: "Search saved memories by literal substring and optional kind.",
        parameters: obj({ query: str(), kind: opt(kind) }), replay: "safe",
        execute: async args => reply(JSON.stringify(search(args.query, args.kind))) }),
      defineTool({ name: "memory_save", description: "Save a lasting preference, goal or important fact. Only goals have deadlines.",
        parameters: saveSchema, execute: async args => reply(save(args)) }),
      defineTool({ name: "memory_update", description: "Edit a memory by ID. Set due to null to clear a goal deadline.",
        parameters: obj({ id, ...patchFields }), execute: async ({ id, ...changes }) => update(id, changes) ? reply(id) : reply("Unknown memory", true) }),
      defineTool({ name: "memory_delete", description: "Delete a memory by ID.",
        parameters: obj({ id }), execute: async ({ id }) => remove(id) ? reply(id) : reply("Unknown memory", true) }),
    ],
    async start() {
      if (dataDir) await mkdir(dataDir, { recursive: true });
      db = new DatabaseSync(dataDir ? join(dataDir, "memory.sqlite") : ":memory:");
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS memory (
          id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL, due INTEGER,
          status TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
          CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, content='memory', content_rowid='id', tokenize='trigram');
          CREATE TRIGGER IF NOT EXISTS memory_insert AFTER INSERT ON memory BEGIN
            INSERT INTO memory_fts(rowid,text) VALUES (new.id,new.text); END;
          CREATE TRIGGER IF NOT EXISTS memory_delete AFTER DELETE ON memory BEGIN
            INSERT INTO memory_fts(memory_fts,rowid,text) VALUES ('delete',old.id,old.text); END;
          CREATE TRIGGER IF NOT EXISTS memory_update AFTER UPDATE OF text ON memory WHEN old.text != new.text BEGIN
            INSERT INTO memory_fts(memory_fts,rowid,text) VALUES ('delete',old.id,old.text);
            INSERT INTO memory_fts(rowid,text) VALUES (new.id,new.text); END;`);
      } catch (error) {
        db.close();
        throw error;
      }
      return async () => db.close();
    },
  };
}
