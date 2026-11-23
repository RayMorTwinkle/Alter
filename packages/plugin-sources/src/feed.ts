import { SourceError, type Item } from "./config.ts";

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s: string) {
  return s.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (whole, key: string) => {
    if (key[0] !== "#") return entities[key.toLowerCase()] ?? whole;
    const n = key[1]?.toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  });
}
export function plain(s: string, limit = 500) {
  return decode(s.replace(/<[^<>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, limit);
}
export function link(s: string, base?: string) {
  try {
    const url = new URL(s, base);
    if (s && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* optional article link */ }
  return "";
}

export function parseFeed(xml: string, base: string): Item[] {
  const tokens = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([\w.:-]+)(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)>|([^<]+)/gy;
  const stack: string[] = [];
  const items: Item[] = [];
  let root = "", depth = 0, key = "", value = "";
  let fields: Record<string, string> = {};
  const invalid = () => new SourceError("Invalid RSS or Atom feed", 502);
  const localName = (s: string) => s.split(":").at(-1)!.toLowerCase();
  let pos = 0;
  while (pos < xml.length) {
    const m = tokens.exec(xml);
    if (!m) throw invalid();
    pos = tokens.lastIndex;
    if (m[1] !== undefined || m[5] !== undefined) {
      const chunk = m[1] ?? decode(m[5]!);
      if (key) value += chunk;
      if (!stack.length && chunk.trim()) throw invalid();
      continue;
    }
    if (!m[3]) continue;
    const tag = localName(m[3]);
    if (!m[2]) {
      if (!stack.length) {
        if (root || !["feed", "rss"].includes(tag)) throw invalid();
        root = tag;
      }
      stack.push(m[3]);
      if (!depth && ((root === "feed" && stack.length === 2 && tag === "entry") ||
          (root === "rss" && stack.length === 3 && localName(stack[1]!) === "channel" && tag === "item"))) {
        depth = stack.length;
        fields = Object.create(null);
      } else if (depth && stack.length === depth + 1) {
        key = tag;
        value = "";
        if (tag === "link" && root === "feed") {
          const attrs = Object.fromEntries([...m[4]!.matchAll(/\s([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(a => [a[1], decode(a[3]!)]));
          if ((!attrs.rel || attrs.rel === "alternate") && attrs.href) fields.href = attrs.href;
        }
      } else if (key) value += " ";
      if (!m[4]?.endsWith("/")) continue;
    }
    if (stack.at(-1) !== m[3]) throw invalid();
    if (depth && stack.length === depth + 1) { fields[key] = value.trim(); key = ""; }
    if (depth && stack.length === depth) {
      const url = link(fields.href || fields.link || "", base);
      const id = fields.guid || fields.id || url;
      const body = plain(fields.summary || fields.description || fields.content || fields.encoded || "");
      const publishedAt = fields.pubdate || fields.published || fields.updated;
      if (id) items.push({ id, title: plain(fields.title || body || id, 240), url, ...(body && { body }), ...(publishedAt && { publishedAt }) });
      depth = 0;
    }
    stack.pop();
  }
  if (!root || stack.length) throw invalid();
  return items;
}
