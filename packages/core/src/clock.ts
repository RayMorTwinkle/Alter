export const defaultTimeZone = "Asia/Shanghai";

export function inputClock(timeZone = defaultTimeZone, now: () => number = Date.now) {
  const format = new Intl.DateTimeFormat("zh-CN", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return () => {
    const at = now();
    const { year, month, day, weekday, hour, minute } = Object.fromEntries(format.formatToParts(at).map(p => [p.type, p.value]));
    return { at, prefix: `[当前时间 ${year}-${month}-${day} ${weekday} ${hour}:${minute} ${timeZone}]` };
  };
}
