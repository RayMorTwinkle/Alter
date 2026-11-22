// Real-gateway check that the model turns relative dates into correct events.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import {
  createGatewayModels, gatewayConfig, loadRepoEnv, observeSurface, openAlter, openNodeSqliteStorage, submitMessage,
} from "@alter/core";
import { createCalendarPlugin } from "../src/index.ts";

type Event = { title: string; start: number; end: number; allDay: number; location: string | null };
type Case = { name: string; turns: string[]; check(events: Event[], day: (offset: number, hour?: number) => number): string | undefined };

const cases: Case[] = [
  { name: "相对日期 + 时长 + 地点", turns: ["明天下午三点在 A 会议室开周报会，一小时"], check(events, day) {
    const [e] = events;
    if (events.length !== 1 || !e) return `应有 1 个日程，实际 ${events.length}`;
    if (e.start !== day(1, 15) || e.end !== day(1, 16)) return `时间不对：${iso(e.start)} – ${iso(e.end)}`;
    if (!e.location?.includes("A")) return `地点不对：${e.location}`;
  } },
  { name: "全天", turns: ["后天全天团建"], check(events, day) {
    const [e] = events;
    if (events.length !== 1 || !e) return `应有 1 个日程，实际 ${events.length}`;
    if (!e.allDay || e.start !== day(2) || e.end !== day(3)) return `全天日程不对：${iso(e.start)} – ${iso(e.end)} allDay=${e.allDay}`;
  } },
  { name: "多轮改时间", turns: ["明天上午十点和导师开会，半小时", "改到下午两点，时长不变"], check(events, day) {
    const [e] = events;
    if (events.length !== 1 || !e) return `应有 1 个日程，实际 ${events.length}`;
    if (e.start !== day(1, 14) || e.end !== day(1, 14) + 30 * 60_000) return `时间不对：${iso(e.start)} – ${iso(e.end)}`;
  } },
];

const iso = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");

loadRepoEnv();
const config = gatewayConfig();
if (config.timeZone !== "Asia/Shanghai") throw new Error("live check assumes ALTER_TZ=Asia/Shanghai");
// Shanghai has no DST, so local midnight is UTC midnight minus eight hours.
const todayUtc = Math.floor((Date.now() + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 8 * 3_600_000;
const day = (offset: number, hour = 0) => todayUtc + offset * 86_400_000 + hour * 3_600_000;

let failed = 0;
for (const c of cases) {
  const dataDir = await mkdtemp(join(tmpdir(), "alter-calendar-live-"));
  try {
    const { models, mainModel, taskModel, thinking } = await createGatewayModels({ ...config, dataDir });
    const app = await openAlter(await openNodeSqliteStorage(join(dataDir, "main.sqlite")), models, mainModel, taskModel, thinking,
      { plugins: [createCalendarPlugin({ dataDir, timeZone: config.timeZone })], timeZone: config.timeZone });
    let last = performance.now();
    let reply = "";
    const surface = await observeSurface(app, event => {
      last = performance.now();
      if (event.event === "timeline" && event.data.kind === "assistant") reply = event.data.text;
    });
    const started = performance.now();
    app.harness.resume();
    for (const turn of c.turns) {
      await submitMessage(app.main, turn);
      last = performance.now();
      const deadline = performance.now() + 180_000;
      while (true) {
        const { busy, tasks } = surface.snapshot();
        if (!busy && tasks.every(task => task.status !== "running") && performance.now() - last > 3_000) break;
        if (performance.now() > deadline) throw new Error("turn timed out");
        await sleep(200);
      }
    }
    surface.detach();
    await app.close();
    const db = new DatabaseSync(join(dataDir, "calendar.sqlite"));
    const events = db.prepare("SELECT * FROM events WHERE deletedAt IS NULL ORDER BY start").all() as Event[];
    db.close();
    const problem = c.check(events, day);
    if (problem) failed++;
    console.log(`${problem ? "✗" : "✓"} ${c.name}（${((performance.now() - started) / 1000).toFixed(1)} s）${problem ? "：" + problem : ""}`);
    for (const e of events) console.log(`    ${e.title} · ${iso(e.start)} – ${iso(e.end)}${e.allDay ? " 全天" : ""}${e.location ? " · " + e.location : ""}`);
    console.log(`    回复：${reply.replace(/\s+/g, " ").slice(0, 120)}`);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
