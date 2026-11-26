import { once } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { context, nodeCapability } from "@alter/core";
import type { Hello, HubMessage, NodeAdapterSummary, NodeMessage } from "@alter/node-protocol";
import { expect, it, vi } from "vitest";
import { say, toolCall } from "../../core/test/fixtures/gateway.ts";
import { installedPlugins } from "../src/plugins.ts";
import { cleanup, setup, stream } from "./web-fixture.ts";

it("leases node tools through the Broker, parks writes until granted, and withdraws tools and pending RPCs on disconnect", async () => {
  vi.stubEnv("ALTER_ROLE", "user");
  cleanup.push(() => { vi.unstubAllEnvs(); });
  let cap = "";
  const web = await setup(({ messages }, res) => {
    const last = messages.at(-1)!;
    if (last.role === "user") {
      if (last.content.endsWith("\nrent")) return toolCall(res, "enable_tool", { capability: cap });
      if (last.content.endsWith("\nread")) return toolCall(res, cap + "_read", {});
      if (last.content.endsWith("\nwrite")) return toolCall(res, cap + "_write", {});
    }
    say(res, "ok");
  }, false, undefined, Date.now, (app, dir) => installedPlugins(app, dir));
  await web.login(); web.app.settings.set("off");
  const { id, token } = await (await web.post("/api/nodes", { name: "Laptop" })).json();
  cap = nodeCapability(id, "local");
  const path = "/api/nodes/" + id + "/adapters";
  expect((await web.read("/api/adapters")).status).toBe(403);
  expect(await (await web.read(path)).json()).toEqual({ online: false, adapters: [] });
  expect((await web.post(path, {})).status).toBe(409);
  expect((await web.post("/api/nodes/unknown/adapters", {})).status).toBe(404);
  const feed = await stream<never, { event: "nodes"; data: { id: string; online: boolean }[] }>(web.read);
  const ws = new WebSocket(web.base.replace("http:", "ws:") + "/api/node/connect", { headers: { Authorization: "Bearer " + token } });
  const closed = once(ws, "close"); cleanup.push(async () => { ws.terminate(); await closed; });
  const calls: Extract<HubMessage, { type: "tool.call" }>[] = [];
  let hold = false, managing = false;
  const send = (m: NodeMessage) => ws.send(JSON.stringify(m));
  ws.on("message", data => {
    const m: HubMessage = JSON.parse(data.toString());
    if (m.type === "adapters.manage") managing = true;
    if (m.type === "tool.call") {
      calls.push(m);
      if (!hold) send({ type: "tool.result", callId: m.callId, ok: true, content: m.toolName });
    }
  });
  await once(ws, "open");
  const adapter: NodeAdapterSummary = { id: "local", name: "Local", kind: "mcp", enabled: true, state: "ok",
    capabilityId: "calendar", effects: {}, tools: (["read", "write"] as const).map(effect => ({
      name: effect, description: "test", defaultEffect: effect, effect, inputSchema: { type: "object", properties: {} },
    })) };
  send({ type: "hello", nodeId: "paired-device", name: "Device", platform: "linux", protocol: 1,
    nodeVersion: "24", tasks: [], roots: [], harnesses: [], adapters: [adapter] } satisfies Hello);
  await feed.seen(e => e.event === "nodes" && e.data.some(n => n.id === id && n.online));
  expect(await (await web.read(path)).json()).toMatchObject({ online: true, adapters: [{ capabilityId: cap }] });
  expect(web.app.capabilities.toolActions.get(cap + "_write")).toEqual({ capability: cap, action: "write", effect: "write" });
  async function message(text: string) {
    await web.post("/api/messages", { text });
    await web.app.main.waitForIdle(context);
  }
  await message("rent"); await message("read");
  expect(calls.map(m => m.toolName)).toEqual(["read"]);
  await web.post("/api/messages", { text: "write" });
  const pending = async () => (await web.state()).pending[0];
  await expect.poll(pending).toMatchObject({ tool: cap + "_write" });
  expect(calls).toHaveLength(1);
  await web.post("/api/permissions/" + (await pending())!.id, { decision: "always" });
  await web.app.main.waitForIdle(context);
  await message("write");
  expect(calls.map(m => m.expectedEffect)).toEqual(["read", "write", "write"]);
  expect(await (await web.read("/api/settings/always-allowed")).json()).toEqual({ capabilities: [cap] });
  hold = true;
  const interrupted = web.app.borrowSource("test", cap + "_read", {}, AbortSignal.timeout(5000)).catch(e => String(e));
  const mutation = web.post(path + "/local/refresh", {});
  await expect.poll(() => managing && calls.length === 4).toBe(true);
  ws.terminate();
  expect(await interrupted).toContain("Source borrow failed");
  const failed = await mutation;
  expect(failed.status).toBe(409);
  expect(await failed.json()).toEqual({ error: "Node disconnected" });
  await feed.seen(e => e.event === "nodes" && e.data.some(n => n.id === id && !n.online));
  expect(web.app.capabilities.toolActions.has(cap + "_read")).toBe(false);
  expect(await (await web.read(path)).json()).toEqual({ online: false, adapters: [] });
  expect(existsSync(join(web.dir, "adapters.json"))).toBe(false);
}, 20_000);
