import { requestUrl, resolvedHeaders, SourceError, type Item, type Spec } from "./config.ts";
import { parseFeed } from "./feed.ts";
import { githubItems, jsonItems } from "@alter/plugin-sdk";

export type PullOptions = { fetch?: typeof fetch; allowLocalHttp?: boolean; timeoutMs?: number };
export type Batch = { items: Item[]; lastModified?: string; pollMs?: number };
export class PullError extends SourceError {
  pollMs?: number;
  constructor(message: string, pollMs?: number) { super(message, 502); this.pollMs = pollMs; }
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
        try {
          if (spec.template === "json") return { items: jsonItems(data, spec.params) };
          batch.items.push(...githubItems(data));
        } catch (error) { throw new PullError((error as Error).message); }
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
