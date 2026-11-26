const dayMs = 86_400_000;
const isoInput = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function dailyMinutes(daily: string) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(daily)) throw new Error("Expected daily time HH:mm");
  return Number(daily.slice(0, 2)) * 60 + Number(daily.slice(3));
}

export function calendarTime(timeZone: string) {
  const offsetFormat = new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "longOffset" });

  // Put local calendar arithmetic on a UTC axis, including historical sub-minute offsets.
  function wall(ms: number) {
    const gmt = offsetFormat.formatToParts(ms).find(p => p.type === "timeZoneName")!.value;
    if (gmt === "GMT") return ms;
    const [hours, minutes = 0, seconds = 0] = gmt.slice(4).split(":").map(Number);
    const offsetMs = ((hours! * 60 + minutes) * 60 + seconds) * 1000;
    return ms + (gmt[3] === "-" ? -offsetMs : offsetMs);
  }

  function instant(local: number, allowGap = false) {
    // Try the offsets on both sides of a transition. In a fold choose the earlier instant.
    const offsets = [local - dayMs, local + dayMs].map(t => wall(t) - t);
    const candidates = offsets.map(offset => local - offset).sort((a, b) => a - b);
    const exact = candidates.find(t => wall(t) === local);
    if (exact !== undefined) return exact;
    const later = candidates.find(t => wall(t) > local);
    if (allowGap && later !== undefined) return later;
    throw new Error(`Local time does not exist in ${timeZone}. Supply a valid time or explicit offset.`);
  }

  function parse(value: string) {
    const match = isoInput.exec(value);
    if (!match) throw new Error("Expected an ISO date or date-time");
    const [, date, h = "00", m = "00", s = "00", fraction = "", offset] = match;
    const local = `${date}T${h}:${m}:${s}.${fraction.slice(0, 3).padEnd(3, "0")}`;
    const utc = Date.parse(local + "Z");
    if (!Number.isFinite(utc) || new Date(utc).toISOString() !== local + "Z") throw new Error("Invalid calendar date or time");
    if (!offset) return { ms: instant(utc, value.length === 10), zone: timeZone };
    const ms = Date.parse(local + offset);
    if (!Number.isFinite(ms)) throw new Error("Invalid time offset");
    return { ms, zone: offset };
  }

  function midnight(ms: number, days = 0) {
    return instant((Math.floor(wall(ms) / dayMs) + days) * dayMs, true);
  }

  function describe(ms: number) {
    const local = wall(ms);
    const date = new Date(local);
    const digits = date.toISOString().slice(0, -1);
    const offset = (local - ms) / 60_000;
    const abs = Math.abs(offset);
    const pad = (n: number) => String(n).padStart(2, "0");
    const iso = Number.isInteger(offset)
      ? digits + (offset < 0 ? "-" : "+") + pad(Math.floor(abs / 60)) + ":" + pad(abs % 60)
      : new Date(ms).toISOString();
    return { iso, label: `${digits.slice(0, 10)} ${digits.slice(11, 16)} (周${"日一二三四五六"[date.getUTCDay()]})` };
  }
  function nextDaily(after: number, daily: string, weekdays?: readonly number[]) {
    const today = Math.floor(wall(after) / dayMs) * dayMs + dailyMinutes(daily) * 60_000;
    // A time zone can skip an entire date (e.g. Apia's Friday in 2011).
    // Include a second week in case the next requested weekday did not exist.
    for (let days = 0; days <= 14; days++) {
      const local = today + days * dayMs;
      if (weekdays && !weekdays.includes(new Date(local).getUTCDay())) continue;
      const candidate = instant(local, true);
      if (candidate > after && (!weekdays || weekdays.includes(new Date(wall(candidate)).getUTCDay()))) return candidate;
    }
    throw new Error("Expected at least one weekday from 0 to 6");
  }

  function quietHours(at: number) {
    const hour = new Date(wall(at)).getUTCHours();
    return hour >= 23 || hour < 8;
  }

  return { parse, midnight, describe, nextDaily, quietHours };
}
