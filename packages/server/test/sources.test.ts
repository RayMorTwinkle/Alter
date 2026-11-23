import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";
import { context, Events } from "@alter/core";
import { installedPlugins } from "../src/plugins.ts";
import { cleanup, setup, stream } from "./web-fixture.ts";

it("serves template previews, baselines on create, and routes only fresh messages through triage after plugin reload", async () => {
  let now = Date.UTC(2026, 10, 23, 4), requests = 0;
  const secret = "offline-only-secret";
  let ids = [4, 3, 2, 1];
  const upstream = createServer((req, res) => {
    requests++;
    if (req.headers.authorization !== "Bearer " + secret) { res.writeHead(401).end(); return; }
    res.end(JSON.stringify({ rows: ids.map(id => ({ id, title: "消息 " + id, href: "/article/" + id, body: secret })) }));
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  cleanup.push(async () => {
    const closed = once(upstream, "close");
    upstream.close();
    upstream.closeAllConnections();
    await closed;
  });
  const url = "http://127.0.0.1:" + (upstream.address() as AddressInfo).port;
  const web = await setup(undefined, false, undefined, () => now, (app, dir) =>
    installedPlugins(app, dir, { ALTER_BROWSER: "off" }, { allowLocalHttp: true }));
  const base = "/api/sources";
  const input = { template: "json", name: "快讯", params: { url, itemsPath: "rows", idField: "id", titleField: "title",
    urlField: "href", bodyField: "body", headers: { authorization: "Bearer ${secret:key}" }, secrets: { key: secret } } };
  expect((await web.read(base)).status).toBe(401);
  await web.login();
  const sse = await stream(web.read);
  await sse.seen(e => e.event === "sources" && !e.data.length);
  const templates = await (await web.read(base + "/templates")).json();
  expect(templates.map((t: { template: string }) => t.template)).toEqual(["rss", "json", "github"]);
  expect(templates[2].fields).toMatchObject([{ key: "token", type: "secret", required: true }]);
  for (const invalid of [{ ...input, intervalMinutes: 4 }, { ...input, params: { ...input.params, url: "http://example.test" } }]) {
    expect((await web.post(base, invalid)).status).toBe(400);
  }
  const unauthorized = await web.post(base, { ...input, params: { ...input.params, headers: {} } });
  expect(unauthorized.status).toBe(502);
  expect(await (await web.read(base)).json()).toEqual([]);
  const preview = await (await web.post(base + "/preview", { template: input.template, params: input.params })).json();
  expect(preview.samples).toHaveLength(3);
  expect(JSON.stringify(preview)).not.toContain(secret);
  expect(await (await web.read(base)).json()).toEqual([]);
  const created = await web.post(base, input);
  expect(created.status).toBe(201);
  const { source, samples } = await created.json();
  expect(samples).toEqual(preview.samples);
  expect(source).toMatchObject({ name: "快讯", enabled: true, intervalMinutes: 30, status: { todayCount: 0, error: null },
    params: { headers: { authorization: { set: true } }, secrets: { key: { set: true } } } });
  expect(requests).toBe(3);
  const events = async () => (await web.app.harness.snapshot(Events, web.app.main.id, context))?.entries ?? [];
  expect(await events()).toEqual([]);
  const edit = (path: string, value: unknown, method = "PATCH") => fetch(web.base + path, { method,
    headers: { cookie: web.sessionCookie(), "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const path = base + "/" + source.id;
  await sse.seen(e => e.event === "plugins" && e.data.some(p => p.provides.sources.includes("快讯")));
  expect((await edit(path, { name: "新闻" })).status).toBe(200);
  expect((await edit("/api/plugins/sources", { enabled: false })).status).toBe(200);
  ids = [5, 5, ...ids];
  now += 30 * 60_000;
  expect((await edit("/api/plugins/sources", { enabled: true })).status).toBe(200);
  await expect.poll(events).toMatchObject([{ source: "feed:新闻", author: "external", untrusted: true, ref: expect.stringContaining("feed:" + source.id + "/") }]);
  await expect.poll(async () => (await web.state()).notifications.filter(n => n.source === "feed:新闻")).toHaveLength(1);
  await sse.seen(e => e.event === "sources" && e.data[0]?.status.todayCount === 1);
  expect(requests).toBe(4);
  expect(JSON.stringify(await events())).not.toContain(secret);
  expect(await (await web.read(base)).text()).not.toContain(secret);
  expect(await (await web.read("/api/plugins")).text()).not.toContain(secret);
  expect(JSON.stringify(sse.events)).not.toContain(secret);
  expect(await readFile(join(web.dir, "secrets.json"), "utf8")).not.toContain(secret);
  expect((await edit(path, undefined, "DELETE")).status).toBe(204);
  expect((await edit(path, { enabled: true })).status).toBe(404);
  await expect.poll(() => sse.events.filter(e => e.event === "sources").at(-1)?.data).toEqual([]);
  expect(await (await web.read(base)).json()).toEqual([]);
});

it("keeps GitHub tokens out of create, preview, patch, lists, SSE and storage on credential rotation", async () => {
  const tokens = ["gh-secret-before", "gh-secret-after"];
  const web = await setup(undefined, false, undefined, Date.now, (app, dir) =>
    installedPlugins(app, dir, { ALTER_BROWSER: "off" }, { fetch: async (_, init) => {
      const token = new Headers(init?.headers).get("Authorization")!.slice(7);
      return Response.json([{ id: "1", repository: { full_name: "org/repo" },
        subject: { type: "Issue", title: token, url: "https://api.github.com/repos/org/repo/issues/42" } }]);
    } }));
  await web.login();
  const sse = await stream(web.read);
  const input = { template: "github", name: "GitHub", params: { token: tokens[0] } };
  const preview = await (await web.post("/api/sources/preview", input)).json();
  const created = await (await web.post("/api/sources", input)).json();
  expect(created.source.params).toEqual({ token: { set: true } });
  expect(created.samples).toEqual(preview.samples);
  expect(created.samples[0].url).toBe("https://github.com/org/repo/issues/42");
  const patched = await (await fetch(web.base + "/api/sources/" + created.source.id, { method: "PATCH", headers: {
    cookie: web.sessionCookie(), "Content-Type": "application/json" }, body: JSON.stringify({ params: { token: tokens[1] } }) })).json();
  await sse.seen(e => e.event === "sources" && e.data.length === 1);
  const output = JSON.stringify([created, preview, patched, sse.events, await (await web.read("/api/sources")).json(),
    await (await web.read("/api/plugins")).json(), await readFile(join(web.dir, "secrets.json"), "utf8")]);
  for (const token of tokens) expect(output).not.toContain(token);
});
