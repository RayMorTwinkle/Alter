import { MapPin, Pause, Play, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useT } from "../i18n.tsx";
import { clock } from "../format.ts";
import type { Agenda, AgendaEvent, ScheduledTask } from "../types.ts";

// Group by the calendar's own time zone, which is what the agent used when it read "tomorrow".
function formatters(timeZone: string, lang: string) {
  const key = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const day = new Intl.DateTimeFormat(lang, { timeZone, month: "long", day: "numeric", weekday: "short" });
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return { key: (ms: number) => key.format(ms), day: (ms: number) => day.format(ms), time: (ms: number) => time.format(ms) };
}

function Schedules({ items, events, onPause, onDelete }: {
  items: ScheduledTask[]; events: AgendaEvent[];
  onPause: (id: string, paused: boolean) => void; onDelete: (id: string) => void;
}) {
  const t = useT().schedules;
  function trigger(item: ScheduledTask) {
    const tr = item.trigger;
    if (tr.kind === "at") return t.once(clock(Date.parse(tr.at)));
    if (tr.kind === "every") return t.every(tr.minutes);
    if (tr.kind === "daily") {
      const days = tr.weekdays ?? [];
      if (!days.length || days.length === 7) return t.daily(tr.time);
      if (days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d))) return t.workdays(tr.time);
      return t.weekly([...days].sort().map(d => t.weekdays[d]).join("、"), tr.time);
    }
    const title = events.find(e => e.id === tr.eventId)?.title ?? tr.eventId;
    return t.event(title, tr.anchor, tr.offsetMinutes);
  }
  const ordered = [...items].sort((a, b) => Number(a.paused) - Number(b.paused) || (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity));
  return (
    <section className="agenda-day schedules">
      <h3><strong>{t.title}</strong></h3>
      <ul className="rows">
        {ordered.map(item => (
          <li key={item.id} className={`schedule-item ${item.paused ? "paused" : ""}`}>
            <div className="row-main">
              <div className="row-title">{item.brief}</div>
              <div className="row-meta">
                <span className="chip">{item.action === "task" ? t.task : t.wake}</span>
                <span>{trigger(item)}</span>
                {item.paused ? <span>{t.paused}</span> : item.nextAt !== null && <span>{t.next(clock(item.nextAt))}</span>}
                {item.continue_from && <span>{t.continues(item.continue_from)}</span>}
                {item.lastRun?.missed && <span>{t.missed}</span>}
              </div>
            </div>
            <div className="schedule-actions">
              <button className="icon-btn ghost" title={item.paused ? t.resume : t.pause} aria-label={item.paused ? t.resume : t.pause}
                onClick={() => onPause(item.id, !item.paused)}>{item.paused ? <Play /> : <Pause />}</button>
              <button className="icon-btn ghost" title={t.remove} aria-label={t.remove}
                onClick={() => { if (confirm(t.confirmRemove)) onDelete(item.id); }}><Trash /></button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AgendaPanel({ agenda, schedules, onPause, onDelete }: {
  agenda: Agenda; schedules: ScheduledTask[];
  onPause: (id: string, paused: boolean) => void; onDelete: (id: string) => void;
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const f = formatters(agenda.timeZone, document.documentElement.lang || "zh-Hans");
  const today = f.key(now);
  const tomorrow = f.key(now + 86_400_000);

  // Ongoing events from earlier days belong under today. All-day events lead each day.
  const days = new Map<string, { at: number; events: AgendaEvent[] }>();
  const ordered = [...agenda.events].sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start);
  for (const event of ordered) {
    const startKey = f.key(event.start);
    const [key, at] = startKey < today ? [today, now] : [startKey, event.start];
    if (!days.has(key)) days.set(key, { at, events: [] });
    days.get(key)!.events.push(event);
  }
  const groups = [...days].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="panel-body">
      {schedules.length > 0 && <Schedules items={schedules} events={agenda.events} onPause={onPause} onDelete={onDelete} />}
      {groups.length === 0 && <p className="empty">{t.emptyAgenda}</p>}
      {groups.map(([key, { at, events }]) => (
        <section key={key} className="agenda-day">
          <h3>
            {key === today ? <strong>{t.today}</strong> : key === tomorrow ? <strong>{t.tomorrow}</strong> : null}
            <span>{f.day(at)}</span>
          </h3>
          <ul className="rows">
            {events.map(event => {
              const live = !event.allDay && event.start <= now && now < event.end;
              // Whole local days between start and end, shown like a timetable's "+1".
              const later = Math.round((Date.parse(f.key(event.end - 1)) - Date.parse(f.key(event.start))) / 86_400_000);
              return (
                <li key={event.id} className={`agenda-item ${live ? "live" : ""}`}>
                  <div className="agenda-time">
                    {event.allDay
                      ? <span>{t.allDay}</span>
                      : <><span>{f.time(event.start)}</span><span>{f.time(event.end)}{later > 0 && <sup>+{later}</sup>}</span></>}
                  </div>
                  <div className="row-main">
                    <div className="row-title">{event.title}</div>
                    {event.location && <div className="row-meta"><span className="agenda-place"><MapPin /> {event.location}</span></div>}
                    {event.notes && <div className="agenda-notes">{event.notes}</div>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
