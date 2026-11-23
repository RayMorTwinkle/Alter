import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { installedPlugins } from "../src/plugins.ts";
import { setup, stream } from "./web-fixture.ts";

it("approves the proposed bytes only via authenticated plugin management and preserves the generic plugin list", async () => {
  const web = await setup(undefined, false, undefined, Date.now, (app, dir) => installedPlugins(app, dir, { ALTER_BROWSER: "off" }));
  const path = join(web.dir, "local");
  mkdirSync(path); writeFileSync(join(path, "index.mjs"), "export default {tools:{get:()=>1}}");
  writeFileSync(join(path, "alter-plugin.json"), JSON.stringify({ schemaVersion: 1, id: "demo", version: "1", displayName: "Demo", description: "test",
    tools: [{ name: "get", description: "get", effect: "read", inputSchema: { type: "object" } }], sources: [], network: [], borrows: [],
    secrets: [], resources: { memoryMB: 128, storageKB: 10, timeoutMs: 1000 } }));
  const base = "/api/ext-plugins", endpoint = base + "/demo";
  expect((await web.post(base + "/install", { path })).status).toBe(401);
  await web.login();
  const events = await stream(web.read);
  await events.seen(e => e.event === "ext-plugins" && e.data.length === 0);
  const response = await web.post(base + "/install", { path });
  expect(response.status).toBe(201);
  const { sha } = await response.json();
  await events.seen(e => e.event === "ext-plugins" && e.data.some(p => p.pending?.sha === sha));
  expect((await web.post("/api/permissions/" + sha, { decision: "task-full" })).status).toBe(409);
  expect((await web.post(endpoint + "/enable", {})).status).toBe(400);
  expect((await web.post(endpoint + "/approve", { sha: "wrong" })).status).toBe(400);
  expect(web.app.capabilities.toolActions.has("ext-demo_get")).toBe(false);
  expect((await web.post(endpoint + "/approve", { sha })).status).toBe(204);
  expect(await (await web.read("/api/plugins")).json()).toContainEqual(expect.objectContaining({
    id: "ext-demo", provides: { channels: [], capabilities: ["ext-demo_get"], sources: [] } }));
  expect(web.app.capabilities.toolActions.get("ext-demo_get")?.effect).toBe("read");
  expect((await web.post(endpoint + "/disable", {})).status).toBe(204);
  expect(web.app.capabilities.toolActions.has("ext-demo_get")).toBe(false);
  expect((await web.post(endpoint + "/enable")).status).toBe(204);
  writeFileSync(join(path, "index.mjs"), "export default {tools:{get:()=>2}}");
  const next = await (await web.post(base + "/install", { path })).json();
  expect((await web.post(endpoint + "/reject")).status).toBe(204);
  expect((await web.post(endpoint + "/approve", {sha:next.sha})).status).toBe(400);
  await web.post(base + "/install", { path });
  expect((await web.post(endpoint + "/approve", {sha:next.sha})).status).toBe(204);
  expect((await web.post(endpoint + "/rollback", {sha})).status).toBe(204);
  expect(await (await web.read(base)).json()).toMatchObject([{active:sha}]);
  expect((await fetch(web.base + endpoint, { method:"DELETE", headers:{cookie:web.sessionCookie(), "content-type":"application/json"} })).status).toBe(204);
  expect(await (await web.read(base)).json()).toEqual([]);
});

it("runs an unattended source borrow as its own restricted task through the broker", async () => {
  const web = await setup();
  const result = await web.app.borrowSource("example", "notes_read", { id: "welcome" }, AbortSignal.timeout(5000));
  expect(result).toBe("Remember the planning meeting.");
  const { Audit, context } = await import("@alter/core");
  const audit = await web.app.harness.snapshot(Audit, web.app.main.id, context);
  expect(audit?.entries).toContainEqual(expect.objectContaining({ borrower: "example", tool: "notes_read", decision: "allow" }));
  await expect(web.app.borrowSource("example", "outbox_send", { message: "fixture" }, AbortSignal.timeout(5000))).rejects.toThrow();
  expect(web.app.demo.outbox).toEqual([]);
});
