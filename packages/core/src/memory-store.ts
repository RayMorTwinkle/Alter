import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { bool, compile, int, nullable, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";
import { calendarTime } from "./calendar-time.ts";

export const entryType = oneOf(["user", "preference", "goal", "reference"]);
export const status = oneOf(["active", "done", "pending"]);
export const nonempty = str({ pattern: "\\S" });
export const due = int({ minimum: -8.64e15, maximum: 8.64e15 });
const entryFields = { title: nonempty, type: entryType, body: nonempty, source: opt(nonempty), guess: opt(bool()), dueAt: opt(due), status: opt(status) };
const entrySchema = obj(entryFields);
const validEntry = compile(entrySchema);
export const patchFields = { title: opt(nonempty), type: opt(entryType), body: opt(nonempty), source: opt(nonempty),
  guess: opt(bool()), dueAt: opt(nullable(due)), status: opt(status) };
const validPatch = compile(obj(patchFields));
export type EntryInput = Static<typeof entrySchema>;
export type EntryPatch = Partial<Omit<EntryInput, "dueAt">> & { dueAt?: number | null };
export type MemoryEntry = EntryInput & { id: string; source: string; guess: boolean; status: Static<typeof status>;
  createdAt: number; updatedAt: number; supersededBy?: string };
export type Operation =
  | { op: "add"; entry: EntryInput }
  | { op: "modify"; id: string; patch: EntryPatch }
  | { op: "supersede"; ids: string[]; entry: EntryInput }
  | { op: "keep"; id?: string }
  | { op: "delete"; id: string };
type Snapshot = { id: string; before: MemoryEntry | null; after: MemoryEntry | null };
export type MemoryChange = { id: string; at: number; kind: "write" | "consolidate" | "undo" | "expire";
  operations: { op: Operation["op"] | "restore"; ids: string[] }[]; snapshots: Snapshot[]; undoneBy?: string };
export class MemoryInputError extends Error {}
export class MemoryConflict extends MemoryInputError {}
export const migratedType = { profile: "user", goal: "goal", fact: "reference" } as const;
const labels = { user: "用户", preference: "偏好", goal: "目标", reference: "参考" };
export function sentence(value: string, limit: number) {
  const first = value.trim().split(/(?<=[。！？!?])|(?<=\.)\s|[\r\n]/u, 1)[0] || value;
  return [...first.trim()].slice(0, limit).join("");
}
function indexLine(e: MemoryEntry) {
  const goal = e.type === "goal" ? "，" + { active: "进行中", pending: "待确认", done: "已完成" }[e.status] : "";
  const deadline = e.dueAt === undefined ? "" : "，期限 " + new Date(e.dueAt).toISOString();
  const title = e.title.trim().replace(/\s+/g, " ");
  const hint = sentence(e.body, 60).replace(/\s+/g, " ");
  return `[${labels[e.type]}] ${title}${hint.startsWith(title) ? "" : " — " + hint}（#${e.id}${e.guess ? "，猜的" : ""}${goal}${deadline}）`;
}

export function openMemoryStore(path: string, now: () => number, timeZone: string, initial?: { entries: MemoryEntry[]; sequence: number }) {
  const db = new DatabaseSync(path);
  const time = calendarTime(timeZone);
  const dated = (at: number) => "整理于 " + time.describe(at).iso.slice(0, 10);
  function transaction<T>(work: () => T) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function restore(e: MemoryEntry) {
    db.prepare("INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(e.id, e.title, e.type, e.body, e.source,
      Number(e.guess), e.dueAt ?? null, e.status, e.createdAt, e.updatedAt, e.supersededBy ?? null);
  }
  try {
    transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL,
        source TEXT NOT NULL, guess INTEGER NOT NULL, dueAt INTEGER, status TEXT NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, supersededBy INTEGER);
        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(title, body, content='entries', content_rowid='id', tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS entry_insert AFTER INSERT ON entries BEGIN
          INSERT INTO entries_fts(rowid,title,body) VALUES(new.id,new.title,new.body); END;
        CREATE TRIGGER IF NOT EXISTS entry_delete AFTER DELETE ON entries BEGIN
          INSERT INTO entries_fts(entries_fts,rowid,title,body) VALUES('delete',old.id,old.title,old.body); END;
        CREATE TRIGGER IF NOT EXISTS entry_update AFTER UPDATE OF title,body ON entries BEGIN
          INSERT INTO entries_fts(entries_fts,rowid,title,body) VALUES('delete',old.id,old.title,old.body);
          INSERT INTO entries_fts(rowid,title,body) VALUES(new.id,new.title,new.body); END;
        CREATE TABLE IF NOT EXISTS changes (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,
          operations TEXT NOT NULL, snapshots TEXT NOT NULL, undoneBy INTEGER, batch TEXT UNIQUE);`);
      if (initial) {
        for (const entry of initial.entries) restore(entry);
        db.prepare("DELETE FROM sqlite_sequence WHERE name='entries'").run();
        db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('entries',?)").run(initial.sequence);
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory'").get()) {
        const insert = db.prepare("INSERT INTO entries VALUES(?,?,?,?,?,0,?,?,?,?,NULL)");
        for (const row of db.prepare("SELECT * FROM memory ORDER BY id").iterate()) {
          insert.run(row.id!, sentence(String(row.text), 30), migratedType[row.kind as keyof typeof migratedType], row.text!,
            dated(Number(row.createdAt)), row.due!, row.status!, row.createdAt!, row.updatedAt!);
        }
        db.exec(`DELETE FROM sqlite_sequence WHERE name='entries';
          INSERT INTO sqlite_sequence(name,seq) SELECT 'entries',seq FROM sqlite_sequence WHERE name='memory';
          DROP TABLE memory; DROP TABLE IF EXISTS memory_fts;`);
      }
    });
  } catch (error) { db.close(); throw error; }

  function entries(where = "supersededBy IS NULL", ...args: SQLInputValue[]): MemoryEntry[] {
    return db.prepare("SELECT * FROM entries WHERE " + where + " ORDER BY updatedAt DESC,id DESC").all(...args).map(row => {
      const { id, dueAt, supersededBy, guess, ...fields } = row;
      return { ...fields, id: String(id), guess: !!guess, ...(dueAt != null && { dueAt }), ...(supersededBy != null && { supersededBy: String(supersededBy) }) } as MemoryEntry;
    });
  }
  const read = (id: string) => entries("id=?", id)[0];
  const revision = () => Number(db.prepare("SELECT coalesce(max(id),0) AS rev FROM changes").get()!.rev);
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  function log(kind: MemoryChange["kind"], operations: MemoryChange["operations"], before: Map<string, MemoryEntry | null>, batch?: string) {
    const snapshots = Array.from(before, ([id, value]) => ({ id, before: value, after: read(id) ?? null }));
    return String(db.prepare("INSERT INTO changes(at,kind,operations,snapshots,batch) VALUES(?,?,?,?,?)")
      .run(now(), kind, JSON.stringify(operations), JSON.stringify(snapshots), batch ?? null).lastInsertRowid);
  }
  function insert(input: EntryInput, goalStatus: MemoryEntry["status"]) {
    if (!validEntry.check(input)) throw new MemoryInputError("Expected type, title and body");
    if (input.dueAt != null && input.type !== "goal") throw new MemoryInputError("Only goals have deadlines");
    const at = now();
    return String(db.prepare(`INSERT INTO entries(title,type,body,source,guess,dueAt,status,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(input.title.trim(), input.type, input.body.trim(), input.source ?? dated(at), Number(input.guess ?? false), input.dueAt ?? null, input.status ?? goalStatus, at, at).lastInsertRowid);
  }
  function edit(old: MemoryEntry, patch: EntryPatch) {
    if (!validPatch.check(patch) || !Object.keys(patch).length) throw new MemoryInputError("Expected an entry patch");
    const e = { ...old, ...patch };
    if (e.dueAt != null && e.type !== "goal") throw new MemoryInputError("Only goals have deadlines");
    const at = now();
    const revived = old.status === "pending" && patch.dueAt != null && patch.dueAt > at;
    db.prepare("UPDATE entries SET title=?,type=?,body=?,source=?,guess=?,dueAt=?,status=?,updatedAt=? WHERE id=?")
      .run(e.title.trim(), e.type, e.body.trim(), e.source, Number(e.guess), e.dueAt ?? null, patch.status ?? (revived ? "active" : old.status), at, old.id);
  }
  const processed = (batch: string) => !!db.prepare("SELECT 1 FROM changes WHERE batch=?").get(batch);
  function lastBatch() {
    return db.prepare("SELECT batch FROM changes WHERE batch IS NOT NULL ORDER BY id DESC LIMIT 1").get()?.batch as string | undefined;
  }
  function apply(actions: Operation[], kind: MemoryChange["kind"] = "write", batch?: string, expected?: number) {
    const operations = transaction(() => {
      if (batch && processed(batch)) return [];
      if (expected !== undefined && revision() !== expected) throw new MemoryConflict("Memory changed during consolidation");
      const before = new Map<string, MemoryEntry | null>();
      const operations: MemoryChange["operations"] = [];
      function existing(id: string) {
        const old = read(id);
        if (!old || old.supersededBy) throw new MemoryInputError("Unknown active memory");
        if (!before.has(id)) before.set(id, old);
        return old;
      }
      for (const action of actions) {
        const ids: string[] = [];
        if (action.op === "add" || action.op === "supersede") {
          const prior = action.op === "supersede" ? action.ids.map(existing) : [];
          if (action.op === "supersede" && !prior.length) throw new MemoryInputError("Expected entries to supersede");
          const retainedStatus = prior.length > 1 && action.entry.type === "goal" && prior.every(e => e.status === prior[0]!.status)
            ? prior[0]!.status : "active";
          const id = insert(action.entry, retainedStatus);
          before.set(id, null);
          for (const old of prior) {
            db.prepare("UPDATE entries SET supersededBy=?,updatedAt=? WHERE id=?").run(id, now(), old.id);
            ids.push(old.id);
          }
          ids.push(id);
        } else if (action.op !== "keep") {
          const old = existing(action.id);
          if (action.op === "modify") edit(old, action.patch);
          else db.prepare("DELETE FROM entries WHERE id=?").run(old.id);
          ids.push(action.id);
        } else if (action.id) {
          if (!read(action.id)) throw new MemoryInputError("Unknown memory");
          ids.push(action.id);
        }
        operations.push({ op: action.op, ids });
      }
      log(kind, operations, before, batch);
      return operations;
    });
    notify();
    return operations;
  }
  function refresh() {
    const expired = entries("supersededBy IS NULL AND type='goal' AND status='active' AND dueAt < ?", now());
    if (expired.length) apply(expired.map(e => ({ op: "modify", id: e.id, patch: { status: "pending" } })), "expire");
  }
  function changes(where = "1", ...args: SQLInputValue[]): MemoryChange[] {
    return db.prepare("SELECT * FROM changes WHERE " + where + " ORDER BY id DESC").all(...args).map(row => ({
      id: String(row.id), at: Number(row.at), kind: row.kind as MemoryChange["kind"], operations: JSON.parse(String(row.operations)),
      snapshots: JSON.parse(String(row.snapshots)), ...(row.undoneBy != null && { undoneBy: String(row.undoneBy) }),
    }));
  }
  function undo(id: string) {
    const result = transaction(() => {
      const change = changes("id=?", id)[0];
      if (!change) return false;
      if (change.undoneBy || change.kind === "undo") throw new MemoryConflict("Change already reverted or is an undo");
      const before = new Map<string, MemoryEntry | null>();
      for (const s of change.snapshots) {
        const current = read(s.id) ?? null;
        if (JSON.stringify(current) !== JSON.stringify(s.after)) throw new MemoryConflict("Entry has newer changes");
        before.set(s.id, current);
        db.prepare("DELETE FROM entries WHERE id=?").run(s.id);
        const e = s.before;
        if (e) restore(e);
      }
      const undoId = log("undo", [{ op: "restore", ids: [...before.keys()] }], before);
      db.prepare("UPDATE changes SET undoneBy=? WHERE id=?").run(undoId,id);
      return true;
    });
    if (result) notify();
    return result;
  }
  function search(query: string) {
    refresh();
    const indexed = [...query].length >= 3;
    if (indexed) return entries("supersededBy IS NULL AND id IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)",
      '"' + query.replaceAll('"', '""') + '"');
    const term = "%" + query.replace(/[!%_]/g, "!$&") + "%";
    return entries("supersededBy IS NULL AND (title LIKE ? ESCAPE '!' OR body LIKE ? ESCAPE '!')", term, term);
  }
  function seed() {
    return { entries: entries(), sequence: Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='entries'").get()?.seq ?? 0) };
  }
  function view() {
    refresh();
    const active = entries();
    const index = active.map(indexLine).join("\n");
    return { index, entries: active, needsConsolidation: [...index].length > 2000 };
  }
  function delta(since: number) {
    const snapshots = new Map<string, Snapshot>();
    for (const change of changes("id>?", since).reverse()) for (const s of change.snapshots) {
      const first = snapshots.get(s.id);
      snapshots.set(s.id, first ? { ...s, before: first.before } : s);
    }
    const lines: string[] = [];
    for (const s of snapshots.values()) {
      const before = s.before?.supersededBy ? null : s.before;
      const after = s.after?.supersededBy ? null : s.after;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      if (after) lines.push((before ? "修改 " : "新增 ") + indexLine(after));
      else if (before) lines.push("删除 #" + s.id + " " + before.title.replace(/\s+/g, " "));
    }
    return lines.length ? "记忆更新：" + lines.join(" / ") : "";
  }
  return { entries, seed, read, apply, refresh, view, delta, changes, revision, lastBatch, undo, search, listeners, close: () => db.close() };
}
