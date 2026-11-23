import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { context, type PluginView } from "@alter/core";
import { browserDescription } from "@alter/plugin-browser";
import { calendarDescription, calendarInstance } from "@alter/plugin-calendar";
import { feishuDescription } from "@alter/plugin-feishu";
import { mailDescription } from "@alter/plugin-mail";
import { say, toolCall } from "../../core/test/fixtures/gateway.ts";
import { createPluginManager } from "../src/plugin-manager.ts";
import { installedPlugins } from "../src/plugins.ts";
import { setup, stream } from "./web-fixture.ts";

it("serves all installed plugins with partial credentials and changes the live calendar registration", async () => {
  const start = new Date(Date.now() + 3_600_000).toISOString();
  const web = await setup(({ messages }, res) => {
    if (messages.at(-1)?.content?.endsWith("\nbook")) return toolCall(res, "enable_tool", { capability: "calendar", reason: "book" });
    if (messages.at(-1)?.content === "Enabled calendar") return toolCall(res, "calendar_create", { title: "热重载验证", start });
    say(res, "done");
  }, false, undefined, Date.now, (app, dir) =>
    installedPlugins(app, dir, { ALTER_BROWSER: "off", ALTER_FEISHU_APP_ID: "cli_partial", ALTER_MAIL_ADDRESS: "me@example.com" }));
  expect((await web.read("/api/plugins")).status).toBe(401);
  expect((await web.read("/api/plugins/feishu/guide")).status).toBe(401);
  await web.login();
  const views = await (await web.read("/api/plugins")).json();
  expect(views.map((view: PluginView) => [view.id, view.status.state])).toEqual([
    ["calendar", "ok"], ["feishu", "needs-config"], ["mail", "needs-config"], ["browser", "off"], ["sources", "ok"]]);
  expect((await web.post("/api/plugins/unknown/check")).status).toBe(404);
  const guide = await (await web.read("/api/plugins/feishu/guide")).json();
  expect(guide.redirectUri).toBe(web.base + "/api/feishu/oauth/callback");
  expect(guide.eventsMode).toBe("long-connection");
  expect(JSON.parse(guide.permissionsJson).scopes.user).toContain("offline_access");
  const toggle = (enabled: boolean) => fetch(web.base + "/api/plugins/calendar", { method: "PATCH",
    headers: { cookie: web.sessionCookie(), "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
  expect(await (await toggle(false)).json()).toMatchObject({ enabled: false, status: { state: "off" } });
  expect((await web.read("/api/calendar")).status).toBe(404);
  expect(web.app.capabilities.toolActions.has("calendar_create")).toBe(false);
  expect(await (await toggle(true)).json()).toMatchObject({ enabled: true, status: { state: "ok" } });
  expect(await (await web.read("/api/calendar")).json()).toMatchObject({ events: [] });
  expect(web.app.capabilities.toolActions.has("calendar_create")).toBe(true);
  await web.post("/api/messages", { text: "book" });
  await expect.poll(async () => (await (await web.read("/api/calendar")).json()).events).toMatchObject([{ title: "热重载验证" }]);
  await web.app.main.waitForIdle(context);
  await web.close();
  const reopened = await web.reopen();
  await reopened.login();
  expect((await reopened.state()).leases.map(lease => lease.capability)).toContain("calendar");
  expect(await (await reopened.read("/api/calendar")).json()).toMatchObject({ events: [{ title: "热重载验证" }] });
  const { leases } = await (await reopened.read("/api/stats?range=all")).json();
  expect(leases).toMatchObject({ count: 1, byTool: { calendar_create: 1, calendar_list: 1 }, taintedRate: 0,
    dispatchAfterLeaseRate: 0, items: [{ reason: "book", approved: false, calls: 1, succeeded: 1 }] });
});

it("serializes reloads, checks and masks saved and environment credentials on every transport", async () => {
  const starts: string[] = [], stops: string[] = [];
  let checks = 0;
  const fallback = "offline-env-credential", saved = "offline-saved-credential";
  const web = await setup(undefined, false, undefined, Date.now, (app, dir) => createPluginManager(app, dir, [
    { description: feishuDescription, open(env) {
      const secret = env.ALTER_FEISHU_APP_SECRET!;
      if (env.ALTER_FEISHU_APP_ID === "invalid") throw new Error("SDK included " + secret);
      return { plugin: { capability: { id: "feishu", actions: [], mainLeasable: false }, tools: [], async start() {
        starts.push(secret); return async () => { stops.push(secret); };
      } }, status() { checks++; return { state: "ok" }; } };
    } },
    { description: calendarDescription, open: () => calendarInstance(dir, app.timeZone) },
    { description: mailDescription, open() { throw new Error("Missing credentials"); } },
    { description: browserDescription, enabled: false, open() { throw new Error("Disabled"); } },
  ], { ALTER_FEISHU_APP_ID: "old", ALTER_FEISHU_APP_SECRET: fallback }));
  await web.login();
  const feed = await stream(web.read);
  const patch = (value: unknown) => fetch(web.base + "/api/plugins/feishu", { method: "PATCH",
    headers: { cookie: web.sessionCookie(), "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const secrets = (text: string) => { expect(text).not.toContain(fallback); expect(text).not.toContain(saved); };
  const redirect = "https://example.test/api/feishu/oauth/callback";
  const view = await (await patch({ settings: { ALTER_FEISHU_APP_ID: "new", ALTER_FEISHU_APP_SECRET: saved, ALTER_FEISHU_REDIRECT_URI: redirect } })).json();
  expect(view.values).toMatchObject({ ALTER_FEISHU_APP_SECRET: { set: true }, ALTER_FEISHU_APP_ID: "new" });
  expect(await (await web.read("/api/plugins/feishu/guide")).json()).toMatchObject({ redirectUri: redirect });
  secrets(await readFile(join(web.dir, "secrets.json"), "utf8"));
  expect(starts).toEqual([fallback, saved]);
  expect(stops).toEqual([fallback]);
  const before = checks;
  secrets(await (await web.post("/api/plugins/feishu/check", {})).text());
  expect(checks).toBe(before + 1);
  for (const invalid of [{}, { settings: {} }, { enabled: "off" }, { settings: { other: saved } },
    { settings: { ALTER_FEISHU_DOMAIN: "invalid" } }, { settings: { ALTER_FEISHU_APP_SECRET: false } }]) {
    expect((await patch(invalid)).status).toBe(400);
  }
  const failed = await (await patch({ settings: { ALTER_FEISHU_APP_ID: "invalid" } })).json();
  expect(failed.status).toMatchObject({ state: "error", detail: expect.any(String) });
  secrets(JSON.stringify(failed));
  await feed.seen(e => e.event === "plugins" && e.data.some(p => p.id === "feishu" && p.status.state === "error"));
  expect(await (await patch({ enabled: false })).json()).toMatchObject({ enabled: false, status: { state: "off" } });
  expect(await (await patch({ enabled: true, settings: { ALTER_FEISHU_APP_ID: null, ALTER_FEISHU_APP_SECRET: null } })).json())
    .toMatchObject({ values: { ALTER_FEISHU_APP_ID: "old", ALTER_FEISHU_APP_SECRET: { set: true } }, status: { state: "ok" } });
  expect(starts).toEqual([fallback, saved, fallback]);
  expect(stops).toEqual([fallback, saved]);
  secrets(await (await web.read("/api/plugins")).text());
  secrets(JSON.stringify(view));
  secrets(JSON.stringify(feed.events));
  secrets(await readFile(join(web.dir, "secrets.json"), "utf8"));
});

it("applies a partial heartbeat patch immediately and restores the window and deadline after restart", async () => {
  const at = Date.parse("2026-01-05T12:00:00+08:00");
  const web = await setup(undefined, false, undefined, () => at);
  await web.login();
  const patch = (value: unknown) => fetch(web.base + "/api/settings", { method: "PATCH",
    headers: { cookie: web.sessionCookie(), "Content-Type": "application/json" }, body: JSON.stringify(value) });
  expect((await patch({ approvalModel: "auto", heartbeat: { start: "99:00" } })).status).toBe(400);
  expect((await patch({ heartbeat: { extra: true } })).status).toBe(400);
  expect((await patch({ heartbeat: { start: "23:00" } })).status).toBe(400);
  expect(await (await patch({ heartbeat: { enabled: false } })).json()).toMatchObject({ approvalModel: "shadow", heartbeat: { enabled: false } });
  expect(await (await web.read("/api/heartbeat")).json()).toMatchObject({ enabled: false, nextAt: null });
  await patch({ heartbeat: { enabled: true, start: "22:00", end: "02:00" }, approvalModel: "auto" });
  const nextAt = Date.parse("2026-01-05T22:00:00+08:00");
  expect(await (await web.read("/api/heartbeat")).json()).toMatchObject({ enabled: true, nextAt });
  await patch({ heartbeat: { start: "21:00" } });
  expect(await (await web.read("/api/heartbeat")).json()).toMatchObject({ nextAt: nextAt - 3_600_000 });
  await web.close();
  const reopened = await web.reopen();
  await reopened.login();
  expect(await (await reopened.read("/api/settings")).json()).toEqual({ approvalModel: "auto", heartbeat: { enabled: true, start: "21:00", end: "02:00" } });
  expect(await (await reopened.read("/api/heartbeat")).json()).toMatchObject({ nextAt: nextAt - 3_600_000 });
});

it.each(["mail", "feishu"] as const)("keeps an active %s watch polling with the saved settings after reload", async channel => {
  const start = Date.parse("2026-11-01T12:00:00+08:00");
  let now = start;
  const secretKey = channel === "mail" ? "ALTER_MAIL_AUTH_CODE" : "ALTER_FEISHU_APP_SECRET";
  const description = channel === "mail" ? mailDescription : feishuDescription;
  const env = { ALTER_MAIL_ADDRESS: "me@example.test", ALTER_FEISHU_APP_ID: "cli_offline", [secretKey]: "old" };
  const polls: { credential: string; since: number; until: number }[] = [];
  const authorized: string[] = [], stopped: string[] = [];
  let release!: () => void;
  const firstRead = new Promise<void>(resolve => { release = resolve; });
  const web = await setup(undefined, false, undefined, () => now, (app, dir) => createPluginManager(app, dir, [
    { description, open(config) {
      const credential = config[secretKey]!;
      return { status: () => ({ state: "ok" }), plugin: {
        capability: { id: channel, mainLeasable: false, actions: [] }, tools: [],
        async start() { return async () => { stopped.push(credential); }; },
        watchSource: {
          async authorize() { authorized.push(credential); },
          async poll(_, since, until) {
            polls.push({ credential, since, until });
            if (credential === "old") await firstRead;
            if (until === start + 120_000) return [];
            return [{ source: channel, kind: "message", at: until - 1, ref: channel + "-" + credential,
              summary: "盯梢测试", untrusted: true }];
          },
        },
      } };
    } },
  ], env));
  await web.login();
  const patch = (value: unknown) => fetch(web.base + "/api/plugins/" + channel, { method: "PATCH",
    headers: { cookie: web.sessionCookie(), "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const advance = () => { now += 60_000; web.app.harness.resume(); };
  const id = await web.app.watches.create({ brief: "观察", where: { channel }, until: 6 });
  expect(authorized).toEqual(["old"]);
  advance();
  await expect.poll(() => polls.length).toBe(1);
  const saved = patch({ settings: { [secretKey]: "new" } });
  try {
    await expect.poll(() => web.app.capabilities.manifests.some(c => c.id === channel)).toBe(false);
    expect(stopped).toEqual([]);
  } finally { release(); }
  expect(await (await saved).json()).toMatchObject({ status: { state: "ok" } });
  expect(stopped).toEqual(["old"]);
  await expect.poll(() => web.app.watches.list()).toMatchObject([{ id, status: "running", pollError: expect.any(String) }]);
  expect(await web.app.notifications.isClaimed(channel + "-old")).toBe(false);
  advance();
  await expect.poll(async () => (await web.app.watches.list())[0]?.pollError).toBeUndefined();

  expect(await (await patch({ enabled: false })).json()).toMatchObject({ status: { state: "off" } });
  advance();
  await expect.poll(() => web.app.watches.list()).toMatchObject([{ id, status: "running", pollError: expect.any(String) }]);
  expect(polls).toHaveLength(2);
  expect(await (await patch({ enabled: true })).json()).toMatchObject({ status: { state: "ok" } });
  advance();
  await expect.poll(() => web.app.notifications.isClaimed(channel + "-new")).toBe(true);
  const watches = await (await web.read("/api/watches")).json();
  expect(watches).toMatchObject([{ id, where: { channel }, status: "running" }]);
  expect(watches[0]).not.toHaveProperty("pollError");
  expect(polls).toEqual([
    { credential: "old", since: start, until: start + 60_000 },
    { credential: "new", since: start, until: start + 120_000 },
    { credential: "new", since: start + 120_000, until: start + 240_000 },
  ]);
});
