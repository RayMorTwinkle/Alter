import { MapPin } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useT } from "../i18n.tsx";
import type { Agenda, AgendaEvent } from "../types.ts";

// Group by the calendar's own time zone, which is what the agent used when it read "tomorrow".
function formatters(timeZone: string, lang: string) {
  const key = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const day = new Intl.DateTimeFormat(lang, { timeZone, month: "long", day: "numeric", weekday: "short" });
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return { key: (ms: number) => key.format(ms), day: (ms: number) => day.format(ms), time: (ms: number) => time.format(ms) };
}

export function AgendaPanel({ agenda }: { agenda: Agenda }) {
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
