import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineTool, reply, schema, type AlterPlugin } from "@alter/core";
import { calendarTime } from "./time.ts";

const { bool, obj, opt, str } = schema;
const id = str({ minLength: 1 });
const title = str({ minLength: 1 });
const date = str({ description: "ISO date-time with optional offset, or YYYY-MM-DD. Unqualified times use the configured time zone." });
const fields = { end: opt(date), allDay: opt(bool()), location: opt(str()), notes: opt(str()) };
type Changes = { title?: string; start?: string; end?: string; allDay?: boolean; location?: string; notes?: string };
type Row = { id: string; title: string; start: number; end: number; startZone: string; endZone: string; allDay: number;
  location: string | null; notes: string | null; deletedAt: number | null; createdAt: number; updatedAt: number };

export function createCalendarPlugin({ dataDir, timeZone, now = Date.now }: {
  dataDir: string; timeZone: string; now?: () => number;
}): AlterPlugin {
  const time = calendarTime(timeZone);
  let db: DatabaseSync;

  function display(row: Row) {
    const start = time.describe(row.start);
    const end = time.describe(row.end);
    const created = time.describe(row.createdAt);
    const updated = time.describe(row.updatedAt);
    const deleted = row.deletedAt === null ? undefined : time.describe(row.deletedAt);
    return { ...row, start: start.iso, end: end.iso, startLabel: start.label, endLabel: end.label,
      allDay: Boolean(row.allDay), location: row.location ?? undefined, notes: row.notes ?? undefined,
      createdAt: created.iso, createdAtLabel: created.label, updatedAt: updated.iso, updatedAtLabel: updated.label,
      deletedAt: deleted?.iso, deletedAtLabel: deleted?.label };
  }

  function overlapping(from: number, to: number, includeDeleted: boolean, except = "") {
    return db.prepare(`SELECT * FROM events WHERE start < ? AND end > ? AND (? OR deletedAt IS NULL)
      AND id != ? ORDER BY start, id`).all(to, from, Number(includeDeleted), except) as Row[];
  }

  function eventRow(args: Changes, old?: Row): Row {
    const title = args.title ?? old?.title;
    if (!title?.trim()) throw new Error("An event title is required");
    const allDay = args.allDay ?? Boolean(old?.allDay);
    const inputStart = args.start === undefined ? undefined : time.parse(args.start);
    const inputEnd = args.end === undefined ? undefined : time.parse(args.end);
    let start = inputStart?.ms ?? old?.start;
    if (start === undefined) throw new Error("An event start is required");
    if (allDay && (inputStart || !old?.allDay)) start = time.midnight(start);

    let end = inputEnd?.ms ?? old?.end;
    if (end === undefined) end = allDay ? time.midnight(start, 1) : start + 3_600_000;
    else if (allDay && inputEnd) end = time.midnight(end);
    else if (allDay && !old?.allDay && end !== time.midnight(end)) end = time.midnight(end, 1);
    if (end <= start) throw new Error("Event end must be after start");

    const at = now();
    const startZone = inputStart?.zone ?? old?.startZone ?? timeZone;
    return { id: old?.id ?? `evt_${randomUUID()}`, title, start, end, startZone,
      endZone: inputEnd?.zone ?? old?.endZone ?? (allDay ? timeZone : startZone),
      allDay: Number(allDay), location: args.location ?? old?.location ?? null, notes: args.notes ?? old?.notes ?? null,
      createdAt: old?.createdAt ?? at, updatedAt: at, deletedAt: null };
  }

  function save(args: Changes, eventId?: string) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const old = eventId === undefined ? undefined
        : db.prepare("SELECT * FROM events WHERE id = ? AND deletedAt IS NULL").get(eventId) as Row | undefined;
      if (eventId !== undefined && !old) throw new Error("Unknown or deleted event");
      const row = eventRow(args, old);
      if (old) {
        db.prepare(`UPDATE events SET title=?, start=?, end=?, startZone=?, endZone=?,
          allDay=?, location=?, notes=?, updatedAt=? WHERE id=?`)
          .run(row.title, row.start, row.end, row.startZone, row.endZone, row.allDay, row.location, row.notes, row.updatedAt, row.id);
      } else {
        db.prepare(`INSERT INTO events (id,title,start,end,startZone,endZone,allDay,location,notes,createdAt,updatedAt,deletedAt)
          VALUES ($id,$title,$start,$end,$startZone,$endZone,$allDay,$location,$notes,$createdAt,$updatedAt,$deletedAt)`).run(row);
      }
      const conflicts = overlapping(row.start, row.end, false, row.id).map(display);
      const result = reply(JSON.stringify({ event: display(row), conflicts }));
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function setDeleted(id: string, deleted: boolean) {
    const at = now();
    const row = db.prepare(`UPDATE events SET updatedAt = CASE WHEN (deletedAt IS NOT NULL) = ? THEN updatedAt ELSE ? END,
      deletedAt = CASE WHEN ? THEN COALESCE(deletedAt, ?) ELSE NULL END WHERE id = ? RETURNING *`)
      .get(Number(deleted), at, Number(deleted), at, id) as Row | undefined;
    if (!row) throw new Error("Unknown event");
    return reply(JSON.stringify(display(row)));
  }

  return {
    capability: { id: "calendar", mainLeasable: true, actions: [
      { name: "list", effect: "read" }, { name: "create", effect: "write-local" }, { name: "update", effect: "write-local" },
      { name: "delete", effect: "write-local" }, { name: "restore", effect: "write-local" },
    ] },
    tools: [
      defineTool({ name: "calendar_list", description: "List events overlapping [from, to), sorted by start. Defaults to seven local dates from today.",
        parameters: obj({ from: opt(date), to: opt(date), includeDeleted: opt(bool()) }), replay: "safe",
        execute: async ({ from, to, includeDeleted }) => {
          const start = from === undefined ? time.midnight(now()) : time.parse(from).ms;
          const end = to === undefined ? time.midnight(start, 7) : time.parse(to).ms;
          if (end <= start) throw new Error("Range end must be after start");
          return reply(JSON.stringify(overlapping(start, end, includeDeleted ?? false).map(display)));
        } }),
      defineTool({ name: "calendar_create", description: "Create a calendar event. Default duration is one hour or one local date for all-day events. All-day end dates are exclusive.",
        parameters: obj({ title, start: date, ...fields }), execute: async args => save(args) }),
      defineTool({ name: "calendar_update", description: "Edit the supplied fields of an event by ID. To move it to a new interval, supply both start and end.",
        parameters: obj({ id, title: opt(title), start: opt(date), ...fields }), execute: async ({ id, ...args }) => save(args, id) }),
      defineTool({ name: "calendar_delete", description: "Soft-delete an event by ID.",
        parameters: obj({ id }), execute: async ({ id }) => setDeleted(id, true) }),
      defineTool({ name: "calendar_restore", description: "Restore a soft-deleted event by ID.",
        parameters: obj({ id }), execute: async ({ id }) => setDeleted(id, false) }),
    ],
    async start() {
      await mkdir(dataDir, { recursive: true });
      db = new DatabaseSync(join(dataDir, "calendar.sqlite"));
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, title TEXT NOT NULL,
          start INTEGER NOT NULL, end INTEGER NOT NULL CHECK(end > start), startZone TEXT NOT NULL, endZone TEXT NOT NULL,
          allDay INTEGER NOT NULL, location TEXT, notes TEXT, deletedAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS events_start ON events(start)`);
      } catch (error) {
        db.close();
        throw error;
      }
      return async () => { db.close(); };
    },
  };
}
