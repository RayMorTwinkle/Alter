import { record, requestUrl, resolvedHeaders, SourceError, type Item, type Spec } from "./config.ts";
import { link, parseFeed, plain } from "./feed.ts";

export type PullOptions = { fetch?: typeof fetch; allowLocalHttp?: boolean; timeoutMs?: number };
export type Batch = { items: Item[]; lastModified?: string; pollMs?: number };
export class PullError extends SourceError {
  pollMs?: number;
  constructor(message: string, pollMs?: number) { super(message, 502); this.pollMs = pollMs; }
}
function atPath(data: unknown, path: string) {
  for (const key of path ? path.split(".") : []) {
    if (!record(data) || !Object.hasOwn(data, key)) return;
    data = data[key];
  }
  return data;
}
function jsonItems(data: unknown, params: Extract<Spec, { template: "json" }>["params"]): Item[] {
  const rows = atPath(data, params.itemsPath);
  if (!Array.isArray(rows)) throw new PullError("itemsPath must select an array");
  return rows.map((row: unknown) => {
    const id = atPath(row, params.idField), title = atPath(row, params.titleField), url = atPath(row, params.urlField);
    const body = params.bodyField && atPath(row, params.bodyField);
    if ((typeof id !== "number" && typeof id !== "string") || !String(id) || typeof title !== "string" || typeof url !== "string") {
      throw new PullError("Invalid JSON item field mapping");
    }
    return { id: String(id), title: plain(title, 240), url: link(url, params.url), ...(typeof body === "string" && { body: plain(body) }) };
  });
}
function githubItems(rows: unknown): Item[] {
  if (!Array.isArray(rows)) throw new PullError("Invalid GitHub notifications");
  return rows.map((row: unknown) => {
    if (!record(row) || typeof row.id !== "string" || !record(row.repository) || !record(row.subject)) throw new PullError("Invalid GitHub notification");
    const { full_name: repo } = row.repository;
    const { title, type, url: apiUrl } = row.subject;
    if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo) || typeof type !== "string" || typeof title !== "string") {
      throw new PullError("Invalid GitHub notification subject");
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

const maxBytes = 2 * 1024 * 1024;
async function readBody(response: Response) {
  if (Number(response.headers.get("content-length")) > maxBytes) throw new PullError("Source response exceeds 2 MiB");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, length).toString("utf8");
      length += value.byteLength;
      if (length > maxBytes) throw new PullError("Source response exceeds 2 MiB");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
}

const githubUrl = "https://api.github.com/notifications";
export async function pull(spec: Spec, lastModified?: string, options: PullOptions = {}, stop?: AbortSignal): Promise<Batch> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const signal = stop ? AbortSignal.any([timeout, stop]) : timeout;
  let url = spec.template === "github" ? githubUrl : spec.params.url;
  const headers: Record<string, string> = spec.template === "github" ? { Accept: "application/vnd.github+json", Authorization: "Bearer " + spec.params.token,
    ...(lastModified && { "If-Modified-Since": lastModified }) } : spec.template === "json" ? resolvedHeaders(spec.params) : {};
  const batch: Batch = { items: [] };
  const visited = new Set<string>();
  try {
    do {
      const response = await (options.fetch ?? fetch)(requestUrl(url, options.allowLocalHttp), { headers, signal, redirect: "error" });
      try {
        if (spec.template === "github") {
          const seconds = Number(response.headers.get("x-poll-interval"));
          if (seconds > 0 && Number.isSafeInteger(seconds * 1000)) batch.pollMs = Math.max(batch.pollMs ?? 0, seconds * 1000);
          if (!visited.size) batch.lastModified = response.headers.get("last-modified") ?? (response.status === 304 ? lastModified : undefined);
          if (response.status === 304 && !visited.size && lastModified) return batch;
        }
        if (!response.ok) throw new PullError("Source HTTP " + response.status, batch.pollMs);
        const body = await readBody(response);
        if (spec.template === "rss") return { items: parseFeed(body, url) };
        const data: unknown = JSON.parse(body);
        if (spec.template === "json") return { items: jsonItems(data, spec.params) };
        batch.items.push(...githubItems(data));
        visited.add(url);
        const next = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
        if (!next) return batch;
        const page = new URL(next);
        if (page.origin + page.pathname !== githubUrl || visited.has(page.href) || visited.size >= 100) throw new PullError("Invalid GitHub pagination");
        delete headers["If-Modified-Since"];
        url = page.href;
      } finally { await response.body?.cancel().catch(() => {}); }
    } while (!signal.aborted);
  } catch (cause) {
    if (cause instanceof PullError) cause.pollMs ??= batch.pollMs;
    if (cause instanceof SourceError) throw cause;
    if (!signal.aborted) throw new PullError(cause instanceof SyntaxError ? "Invalid source response" : "Source request failed", batch.pollMs);
  }
  throw new PullError(timeout.aborted ? "Source request timed out" : "Source request stopped", batch.pollMs);
}
