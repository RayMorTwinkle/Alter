export type Item = { id: string; title: string; url?: string; body?: string; publishedAt?: string; repo?: string; type?: string };
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type HttpRequest = { url: string; method: string; headers?: Record<string,string>; body?: string; secretHeaders?: Record<string,string> };
export type Context = {
  secrets: { get(name: string): Promise<string | undefined>; list(): Promise<string[]> };
  http: { request(input: HttpRequest): Promise<{ status: number; body: string }> };
  kv: { get(key: string): Promise<Json>; set(key: string, value: Json): Promise<void>; delete(key: string): Promise<void>; list(): Promise<string[]> };
  borrow(tool: string, args: Record<string,Json>): Promise<Json>; log(message: string): Promise<void>;
};
type Plugin = {
  init?(ctx: Context): void | Promise<void>;
  close?(): void | Promise<void>;
  tools?: Record<string,(args: Record<string,Json>, ctx: Context) => Json | Promise<Json>>;
  sources?: Record<string,(ctx: Context) => Item[] | Promise<Item[]>>;
};
export const definePlugin = <T extends Plugin>(plugin: T): T => plugin;

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

export function parseFeed(xml: string, base: string): (Item & { url: string })[] {
  const tokens = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([\w.:-]+)(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)>|([^<]+)/gy;
  const stack: string[] = [];
  const items: (Item & { url: string })[] = [];
  let root = "", depth = 0, key = "", value = "";
  let fields: Record<string, string> = {};
  const invalid = () => new Error("Invalid RSS or Atom feed");
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

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function atPath(data: unknown, path: string) {
  for (const key of path ? path.split(".") : []) {
    if (!record(data) || !Object.hasOwn(data, key)) return;
    data = data[key];
  }
  return data;
}
export function jsonItems(data: unknown, params: { url: string; itemsPath: string; idField: string; titleField: string; urlField: string; bodyField?: string }): (Item & { url: string })[] {
  const rows = atPath(data, params.itemsPath);
  if (!Array.isArray(rows)) throw new Error("itemsPath must select an array");
  return rows.map((row: unknown) => {
    const id = atPath(row, params.idField), title = atPath(row, params.titleField), url = atPath(row, params.urlField);
    const body = params.bodyField && atPath(row, params.bodyField);
    if ((typeof id !== "number" && typeof id !== "string") || !String(id) || typeof title !== "string" || typeof url !== "string") {
      throw new Error("Invalid JSON item field mapping");
    }
    return { id: String(id), title: plain(title, 240), url: link(url, params.url), ...(typeof body === "string" && { body: plain(body) }) };
  });
}
export function githubItems(rows: unknown): (Item & { url: string })[] {
  if (!Array.isArray(rows)) throw new Error("Invalid GitHub notifications");
  return rows.map((row: unknown) => {
    if (!record(row) || typeof row.id !== "string" || !record(row.repository) || !record(row.subject)) throw new Error("Invalid GitHub notification");
    const { full_name: repo } = row.repository;
    const { title, type, url: apiUrl } = row.subject;
    if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo) || typeof type !== "string" || typeof title !== "string") {
      throw new Error("Invalid GitHub notification subject");
    }
    const path = typeof apiUrl === "string" && apiUrl.startsWith("https://api.github.com/repos/" + repo + "/")
      ? apiUrl.slice(("https://api.github.com/repos/" + repo + "/").length) : "";
    const resource = /^(issues|pulls|discussions|commits|releases)\/([\w-]+)$/.exec(path);
    const html = "https://github.com/" + repo;
    const suffix = resource?.[1] === "releases" ? "/releases" :
      resource ? "/" + ({ pulls: "pull", commits: "commit" }[resource[1]!] ?? resource[1]) + "/" + resource[2] : "";
    return { id: row.id, repo, type, title: plain(title, 240), url: html + suffix };
  });
}

