import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import type { ExternalEvent } from "@alter/core";
import { config } from "../src/config.ts";
import { openSources } from "../src/index.ts";
import { pull, type PullOptions } from "../src/pull.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function endpoint(handler: RequestListener) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}
const local = { allowLocalHttp: true };
function memory() {
  const data = new Map<string, string>();
  return { get: (k: string) => data.get(k), patch(values: Record<string, string | null>) {
    for (const [k, v] of Object.entries(values)) { if (v === null) data.delete(k); else data.set(k, v); }
  } };
}
const modified = "Wed, 21 Oct 2015 07:28:00 GMT";

it("reads RSS and Atom fields, CDATA, HTML, entities and alternate links", async () => {
  const rss = '<?xml version="1.0"?><rss version="2.0"><channel><item><guid>one</guid><title>A &amp; B</title>' +
    '<link>/one</link><pubDate>today</pubDate><description><![CDATA[<b>Hello</b> &amp; ' + "a".repeat(510) + ']]></description></item></channel></rss>';
  const atom = '<a:feed xmlns:a="http://www.w3.org/2005/Atom"><a:entry><a:id>two</a:id><a:updated>now</a:updated>' +
    '<a:title>消息</a:title><a:link rel="self" href="/api/id"/><a:link href="/post" rel="alternate"/>' +
    '<a:summary type="html">&lt;i&gt;Atom&lt;/i&gt; &#x4e2d;</a:summary></a:entry></a:feed>';
  const url = await endpoint((req, res) => res.end(req.url === "/atom" ? atom : req.url === "/bad" ? "<rss><channel>" : rss));
  const read = (path: string) => pull({ template: "rss", params: { url: url + path } }, undefined, local);
  const { items } = await read("/");
  expect(items[0]).toEqual({ id: "one", title: "A & B", url: url + "/one", publishedAt: "today", body: ("Hello & " + "a".repeat(510)).slice(0, 500) });
  expect((await read("/atom")).items).toEqual([{ id: "two", title: "消息", url: url + "/post", publishedAt: "now", body: "Atom 中" }]);
  await expect(read("/bad")).rejects.toThrow("Invalid RSS");
});

it("maps nested JSON fields with scoped secrets and rejects broken mappings", async () => {
  let auth: string | undefined;
  const url = await endpoint((req, res) => {
    auth = req.headers.authorization;
    res.end(JSON.stringify({ data: { items: [{ id: 12, post: { title: "title", url: "/post", body: "<p>description</p>" } }] } }));
  });
  const params = { url, itemsPath: "data.items", idField: "id", titleField: "post.title", urlField: "post.url", bodyField: "post.body",
    headers: { Authorization: "Bearer ${secret:api}" }, secrets: { api: "fixture123" } };
  const spec = config({ template: "json", name: "Updates", params }, true);
  expect((await pull(spec, undefined, local)).items).toEqual([{ id: "12", title: "title", body: "description", url: url + "/post" }]);
  expect(auth).toBe("Bearer fixture123");
  expect(() => config({ ...spec, params: { ...params, secrets: {} } }, true)).toThrow("Unknown source secret");
  await expect(pull(config({ ...spec, params: { ...params, itemsPath: "missing" } }, true), undefined, local)).rejects.toThrow("array");
});

it("enforces HTTPS, rejects redirects, caps declared and streaming bytes and times out a stalled body", async () => {
  let redirected = false;
  const url = await endpoint((req, res) => {
    if (req.url === "/length") res.writeHead(200, { "content-length": 2 ** 21 + 1 }).flushHeaders();
    else if (req.url === "/stream") { res.write(Buffer.alloc(2 ** 20)); res.end(Buffer.alloc(2 ** 20 + 1)); }
    else if (req.url === "/stall") { res.writeHead(200).flushHeaders(); res.write("<rss>"); }
    else if (req.url === "/redirect") res.writeHead(302, { Location: "/target" }).end();
    else { redirected = true; res.end("<rss/>"); }
  });
  const run = (path: string, options: PullOptions = local) => pull({ template: "rss", params: { url: url + path } }, undefined, options);
  await expect(run("/target", { allowLocalHttp: false })).rejects.toThrow("HTTPS");
  for (const path of ["/length", "/stream"]) await expect(run(path)).rejects.toThrow("2 MiB");
  await expect(run("/stall", { ...local, timeoutMs: 50 })).rejects.toThrow("timed out");
  await expect(run("/redirect")).rejects.toThrow("request failed");
  expect(redirected).toBe(false);
});

it("persists the GitHub validator, observes server polling intervals on 304 and errors, and backs off", async () => {
  let status = 200, interval = 720, at = Date.UTC(2026, 1, 1, 12), polls = 0;
  const sent: (string | undefined)[] = [];
  const url = await endpoint((req, res) => {
    expect(req.headers.authorization).toBe("Bearer git-fixture");
    sent.push(req.headers["if-modified-since"]);
    polls++;
    res.writeHead(status, { "X-Poll-Interval": interval, "Last-Modified": modified });
    res.end(status === 200 ? JSON.stringify([{ id: "2", repository: { full_name: "o/r" },
      subject: { title: "review", type: "PullRequest", url: "https://api.github.com/repos/o/r/pulls/23" } }]) : undefined);
  });
  const store = memory();
  const opts = { now: () => at, fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(String(input)).toBe("https://api.github.com/notifications");
    return fetch(url, init);
  } };
  const first = openSources(store, "UTC", opts);
  const { samples, source } = await first.create({ name: "gh", template: "github", intervalMinutes: 5, params: { token: "git-fixture" } });
  expect(samples[0]).toEqual({ id: "2", title: "review", type: "PullRequest", repo: "o/r", url: "https://github.com/o/r/pull/23" });
  expect(source.status.nextPollAt).toBe(at + 720_000);
  const events: ExternalEvent[] = [];
  const host = { async emit(e: ExternalEvent) { events.push(e); } };
  const reopened = openSources(store, "UTC", opts);
  const check = async (code: number, count: number, next: number) => {
    at = reopened.list()[0]!.status.nextPollAt!;
    status = code;
    const stop = await reopened.plugin.start!(host);
    try {
      await expect.poll(() => reopened.list()[0]!.status.lastPollAt).toBe(at);
      expect(polls).toBe(count);
      expect(reopened.list()[0]!.status.nextPollAt).toBe(at + next);
    } finally { await stop(); }
  };
  await check(304, 2, 720_000);
  interval = 900;
  await check(503, 3, 900_000);
  await check(503, 4, 1_200_000);
  expect(reopened.list()[0]!.status.error).toBe("Source HTTP 503");
  await check(200, 5, 900_000);
  expect(reopened.list()[0]!.status.error).toBeNull();
  expect(sent).toEqual([undefined, modified, modified, modified, modified]);
  expect(events).toEqual([]);
});

it("baselines on first enable, keeps 1000 recent IDs, deduplicates a batch, and resumes after partial delivery", async () => {
  let ids = ["a"], at = 0;
  const url = await endpoint((_, res) => res.end(JSON.stringify(ids.map(id => ({ id, name: id, url: "/" + id })))));
  const sources = openSources(memory(), "UTC", { now: () => at, ...local });
  const { source } = await sources.create({ name: "local", enabled: false, template: "json", intervalMinutes: 5,
    params: { url, idField: "id", titleField: "name", urlField: "url" } });
  ids = Array.from({ length: 1001 }, (_, i) => String(i));
  const delivered: string[] = [];
  let fail = false;
  const resume = async () => {
    at = sources.list()[0]!.status.nextPollAt!;
    const stop = await sources.plugin.start!({ async emit(e) {
      expect(e).toMatchObject({ source: "feed:local", author: "external", untrusted: true });
      const id = e.summary.split(" — ")[0]!;
      if (fail && id === "y") throw Error("temporary delivery failure");
      delivered.push(id);
    } });
    try { await expect.poll(() => sources.list()[0]!.status.nextPollAt).toBeGreaterThan(at); } finally { await stop(); }
  };
  await sources.patch(source.id, { enabled: true });
  await resume();
  expect(delivered).toEqual([]);
  ids = ["x", "x", "y", ...ids];
  fail = true;
  await resume();
  expect(delivered).toEqual(["x"]);
  fail = false;
  await resume();
  expect(delivered).toEqual(["x", "y"]);
  ids = ["1000", "x", "1"];
  await resume();
  expect(delivered).toEqual(["x", "y", "1000"]);
  expect(sources.list()[0]!.status.todayCount).toBe(3);
  at += 86_400_000;
  expect(sources.list()[0]!.status.todayCount).toBe(0);
});

it("schedules each source independently and stops polling removed or disabled instances", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(Date.UTC(2026, 1, 1));
  const requests: string[] = [];
  const events: ExternalEvent[] = [];
  const counts = new Map<string, number>();
  const sources = openSources(memory(), "UTC", { fetch: async input => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    const count = (counts.get(path) ?? 0) + 1;
    counts.set(path, count);
    return new Response('<rss><channel><item><guid>' + count + '</guid><title>Message</title></item></channel></rss>');
  } });
  const stop = await sources.plugin.start!({ async emit(e) { events.push(e); } });
  try {
    const add = (name: string, intervalMinutes: number) =>
      sources.create({ template: "rss", name, intervalMinutes, params: { url: "https://example.test/" + name } });
    const a = await add("a", 5), b = await add("b", 7);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(requests).toEqual(["/a", "/b", "/a", "/b", "/a", "/b"]);
    expect(events.map(e => e.source)).toEqual(["feed:a", "feed:b", "feed:a", "feed:b"]);
    await sources.patch(a.source.id, { enabled: false });
    await sources.remove(b.source.id);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(requests).toHaveLength(6);
    expect(sources.list()).toMatchObject([{ name: "a", status: { nextPollAt: null } }]);
  } finally { await stop(); vi.useRealTimers(); }
});

it("sends a GitHub conditional header on the first page and keeps pagination on the notifications endpoint", async () => {
  const links = ['<https://api.github.com/notifications?page=2>; rel="next"', '<https://elsewhere.test/page>; rel="next"'];
  const paths: string[] = [];
  const validators: (string | undefined)[] = [];
  const url = await endpoint((req, res) => {
    const page2 = req.url?.includes("page=2");
    validators.push(req.headers["if-modified-since"]);
    res.writeHead(200, { ...(!page2 && { Link: links.shift()! }), "Last-Modified": page2 ? "ignored" : modified });
    res.end(JSON.stringify([{ id: page2 ? "2" : "1", subject: { title: "Update", type: "Issue" }, repository: { full_name: "org/repo" } }]));
  });
  const spec = { template: "github" as const, params: { token: "local-test-token" } };
  const options = { fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const address = new URL(String(input));
    paths.push(address.href);
    return fetch(url + address.pathname + address.search, init);
  } };
  const batch = await pull(spec, modified, options);
  expect(batch.items.map(item => item.id)).toEqual(["1", "2"]);
  expect(batch.lastModified).toBe(modified);
  expect(validators).toEqual([modified, undefined]);
  await expect(pull(spec, undefined, options)).rejects.toThrow("pagination");
  expect(paths).toEqual(["https://api.github.com/notifications", "https://api.github.com/notifications?page=2", "https://api.github.com/notifications"]);
});

it("delivers a burst larger than the retained history and recognizes unchanged older rows on restart", async () => {
  const store = memory();
  let ids: number[] = [], at = 0;
  const url = await endpoint((_, res) => res.end(JSON.stringify(ids.map(id => ({ id, title: "message", url: "/" + id })))));
  const opts = { now: () => at, ...local };
  const first = openSources(store, "UTC", opts);
  await first.create({ template: "json", name: "big", params: { url, idField: "id", titleField: "title", urlField: "url" } });
  const events: ExternalEvent[] = [];
  const run = async () => {
    const sources = openSources(store, "UTC", opts);
    at = sources.list()[0]!.status.nextPollAt!;
    const stop = await sources.plugin.start!({ async emit(e) { events.push(e); } });
    try { await expect.poll(() => sources.list()[0]!.status.lastPollAt).toBe(at); } finally { await stop(); }
  };
  ids = Array.from({ length: 1250 }, (_, i) => i);
  await run();
  expect(events).toHaveLength(1250);
  ids = [-1, ...ids, 1250];
  await run();
  await run();
  expect(events).toHaveLength(1252);
  expect(new Set(events.map(e => e.ref)).size).toBe(1252);
});
