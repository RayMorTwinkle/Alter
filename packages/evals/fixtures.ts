import { randomInt, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { calendarTime } from "../plugin-calendar/src/time.ts";

export function fixtures(dataDir: string, timeZone: string, now: number) {
  const time = calendarTime(timeZone);
  function date(offset: number) {
    return time.describe(time.midnight(now, offset)).iso.slice(0, 10);
  }
  function day(offset: number, hour = 0, minute = 0) {
    if (!hour && !minute) return time.midnight(now, offset);
    return time.parse(`${date(offset)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`).ms;
  }
  const id = randomUUID();
  const token = randomUUID();
  const title = `星图交流会-${randomUUID().slice(0, 8)}`;
  const location = `展厅-${randomUUID().slice(0, 8)}`;
  const eventText = `活动名称：${title}。时间：${date(1)} 15:00–16:00（${timeZone}）。地点：${location}。`;
  return { dataDir, timeZone, now, day, id, token, title, location, eventText };
}
export type Fixtures = ReturnType<typeof fixtures>;

export async function startPages(f: Fixtures) {
  const price = `${randomInt(100, 1000)}.${randomInt(10)}${randomInt(1, 10)}`;
  const contact = `contact-${randomUUID().slice(0, 8)}@example.test`;
  const details = `/contact-${randomUUID()}`;
  const pages = new Map([
    ["/", `<h1>参展指南</h1><p>展位价格：${price} 元</p><a href="${details}">联系方式</a>`],
    [details, `<h1>联系方式</h1><p>联系邮箱：${contact}</p>`],
    ["/event", `<h1>活动预告</h1><p>${f.eventText}</p>`],
  ]);
  const server = createServer((req, res) => {
    const page = pages.get(req.url ?? "");
    res.writeHead(page ? 200 : 404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page ? '<!doctype html><meta charset="utf-8">' + page : "Not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, price, contact,
    close: () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())) };
}

type Event = { id: string; title: string; start: number; end: number; allDay: number; location: string | null; deletedAt: number | null };
export function events(f: Fixtures, includeDeleted = false) {
  const db = new DatabaseSync(join(f.dataDir, "calendar.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT * FROM events WHERE ? OR deletedAt IS NULL ORDER BY start, id").all(Number(includeDeleted)) as Event[];
  } finally { db.close(); }
}
export function seedEvent(f: Fixtures, id: string, title: string, start: number, end: number) {
  const db = new DatabaseSync(join(f.dataDir, "calendar.sqlite"));
  try {
    db.prepare(`INSERT INTO events (id, title, start, end, startZone, endZone, allDay, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(id, title, start, end, f.timeZone, f.timeZone, f.now, f.now);
  } finally { db.close(); }
}

export function checkEvent(f: Fixtures, title: string, start: number, end: number, allDay = false, location?: string) {
  const rows = events(f);
  if (rows.length !== 1) return `应有 1 个日程，实际 ${rows.length}`;
  const e = rows[0]!;
  if (!e.title.includes(title) || e.start !== start || e.end !== end || !!e.allDay !== allDay ||
      (location && !e.location?.replaceAll(" ", "").includes(location.replaceAll(" ", "")))) {
    return `预期「${title}」${new Date(start).toISOString()} 至 ${new Date(end).toISOString()}，全天=${allDay}，地点=${location ?? "不限"}；实际 ${JSON.stringify(e)}`;
  }
}
