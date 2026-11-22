export function clock(at: number) {
  const date = new Date(at);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

export function pretty(value: unknown) {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

// Rounded up so a request never reads "0 minutes" while it can still be answered.
export function remaining(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes >= 120 ? { n: Math.ceil(minutes / 60), unit: "h" as const } : { n: minutes, unit: "m" as const };
}

export function compactNumber(n: number) {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function seconds(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}
