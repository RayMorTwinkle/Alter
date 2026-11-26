import type { HubMessage, NodeAdapterSummary } from "@alter/node-protocol";
import { expect, it } from "vitest";
import { NodeAdapters, nodeCapability } from "../src/node-adapters.ts";
import type { AlterPlugin } from "../src/capabilities.ts";
import { context } from "../src/runtime.ts";

it("binds replies to the authenticated peer, times out management, cancels tools and ignores late replies", async () => {
  let plugin: AlterPlugin | undefined;
  const adapters = new NodeAdapters(async (_, p) => { plugin = p; }, 50);
  const frames: HubMessage[] = [];
  const peer = { open: () => true, send(m: HubMessage) { frames.push(m); }, close() {} };
  const summary: NodeAdapterSummary = { id: "reader", name: "Reader", kind: "cli", enabled: true, capabilityId: "browser", state: "ok",
    effects: {}, tools: [{ name: "run", description: "read", effect: "read", defaultEffect: "write" }] };
  await adapters.update("pair-1", "Laptop", peer, [summary]);
  expect(plugin!.capability.id).toBe(nodeCapability("pair-1", "reader"));
  expect(plugin!.capability.id).not.toBe(nodeCapability("pair-2", "reader"));
  const result = adapters.manage("pair-1", peer, { action: "list" });
  const sent = frames[0];
  if (sent?.type !== "adapters.manage") throw new Error("Missing management request");
  const reply = { type: "adapters.manage.result" as const, requestId: sent.requestId, ok: true, data: [] };
  adapters.receive({ ...peer }, reply);
  await expect(result).rejects.toMatchObject({ status: 504 });
  adapters.receive(peer, reply);
  const run = plugin!.tools[0]!.execute;
  const execution = run({}, {} as Parameters<typeof run>[1], context);
  const call = frames.at(-1);
  if (call?.type !== "tool.call") throw new Error("Missing node tool call");
  expect(await execution).toMatchObject({ isError: true, details: { untrusted: true } });
  expect(frames.at(-1)).toEqual({ type: "tool.cancel", callId: call.callId });
  adapters.receive(peer, { type: "tool.result", callId: call.callId, ok: true, content: "late" });
});
