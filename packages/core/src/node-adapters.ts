import { createHash, randomUUID } from "node:crypto";
import type { AdapterManagement, AdapterManagementResult, Effect, HubMessage, NodeAdapterSummary, ToolResult } from "@alter/node-protocol";
import { defineTool, reply } from "./runtime.ts";
import type { AlterPlugin } from "./capabilities.ts";
import type { NodePeer } from "./nodes.ts";

export class NodeRpcError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
export function nodeCapability(node: string, adapter: string) {
  return "node-" + adapter.slice(0, 10) + "-" + digest(node + "/" + adapter);
}
type Result = AdapterManagementResult | ToolResult;
type ReplacePlugin = (id: string, plugin?: AlterPlugin, preserve?: boolean) => Promise<void>;
type Pending = { peer: NodePeer; resolve(result: Result): void; reject(error: Error): void };

export class NodeAdapters {
  private pending = new Map<string, Pending>();
  private online = new Map<string, { peer: NodePeer; adapters: NodeAdapterSummary[] }>();
  private listeners = new Set<() => void>();
  private replace: ReplacePlugin;
  private timeoutMs: number;
  constructor(replace: ReplacePlugin, timeoutMs = 120_000) {
    this.replace = replace;
    this.timeoutMs = timeoutMs;
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  list(node: string) { return this.online.get(node)?.adapters ?? []; }

  async update(node: string, label: string, peer: NodePeer, summaries?: NodeAdapterSummary[]) {
    const prior = this.online.get(node);
    const adapters = (summaries ?? []).map(a => ({ ...a, capabilityId: nodeCapability(node, a.id) }));
    if (summaries) this.online.set(node, { peer, adapters });
    else this.online.delete(node);
    for (const old of prior?.adapters ?? []) {
      if (old.enabled && old.state === "ok" && !adapters.some(a => a.id === old.id && a.enabled && a.state === "ok"))
        await this.replace(old.capabilityId, undefined);
    }
    for (const adapter of adapters) {
      if (adapter.state !== "ok" || !adapter.enabled) continue;
      const previous = prior?.adapters.find(a => a.id === adapter.id);
      if (prior?.peer === peer && JSON.stringify(previous) === JSON.stringify(adapter)) continue;
      const id = adapter.capabilityId;
      const actions = adapter.tools.map(({ name, effect }) => ({
        name: id.length + name.length < 64 ? name : name.slice(0, 46 - id.length) + "_" + digest(name), effect,
      }));
      await this.replace(id, {
        capability: { id, summary: id + " (" + label + " / " + adapter.name + ")", actions },
        tools: adapter.tools.map((t, i) => defineTool({ name: id + "_" + actions[i]!.name,
          description: t.description, parameters: t.inputSchema ?? { type: "object", properties: {} },
          execute: async (args, _api, ctx) => {
            try {
              const current = this.online.get(node);
              if (current?.peer !== peer || !current.adapters.some(a => a.id === adapter.id && a.enabled && a.state === "ok" &&
                a.tools.some(tool => tool.name === t.name && tool.effect === t.effect))) throw new Error("Node adapter changed");
              const result = await this.call(peer, adapter.id, t.name, t.effect, args, ctx.abortSignal);
              return { ...reply(result.content ?? "", result.isError), details: { untrusted: true } };
            } catch (error) { return { ...reply(error instanceof Error ? error.message : "Node call failed", true), details: { untrusted: true } }; }
          },
        })),
      });
    }
    for (const fn of this.listeners) fn();
  }

  disconnect(peer: NodePeer) {
    for (const call of this.pending.values()) if (call.peer === peer) call.reject(new NodeRpcError(409, "Node disconnected"));
  }
  receive(peer: NodePeer, result: Result) {
    const pending = this.pending.get(result.type === "tool.result" ? result.callId : result.requestId);
    if (pending?.peer === peer) pending.resolve(result);
  }
  private async request(peer: NodePeer, id: string, message: HubMessage, signal: AbortSignal) {
    if (!peer.open()) throw new NodeRpcError(409, "Node is offline");
    signal.throwIfAborted();
    const abort = () => {
      this.pending.get(id)?.reject(new NodeRpcError(504, "Node request cancelled or timed out"));
      if (message.type === "tool.call" && peer.open()) peer.send({ type: "tool.cancel", callId: id });
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await new Promise<Result>((resolve, reject) => {
        this.pending.set(id, { peer, resolve, reject });
        peer.send(message);
      });
    }
    finally { this.pending.delete(id); signal.removeEventListener("abort", abort); }
  }
  private async call(peer: NodePeer, adapterId: string, toolName: string, expectedEffect: Effect, args: unknown, signal?: AbortSignal) {
    const callId = randomUUID(), timeout = AbortSignal.timeout(this.timeoutMs);
    const result = await this.request(peer, callId, { type: "tool.call", callId, adapterId, toolName, args, expectedEffect },
      signal ? AbortSignal.any([signal, timeout]) : timeout);
    if (result.type !== "tool.result" || !result.ok) throw new Error(result.error || "Node tool failed");
    return result;
  }
  async manage(node: string, peer: NodePeer, command: AdapterManagement) {
    if (this.online.get(node)?.peer !== peer) throw new NodeRpcError(409, "Node does not support adapter management");
    const requestId = randomUUID();
    const result = await this.request(peer, requestId, { ...command, type: "adapters.manage", requestId }, AbortSignal.timeout(this.timeoutMs));
    if (result.type !== "adapters.manage.result") throw new NodeRpcError(502, "Unexpected node response");
    if (!result.ok) throw new NodeRpcError(result.status && [400, 404, 409].includes(result.status) ? result.status : result.status ? 502 : 400,
      result.error || "Node management failed");
    return result.data;
  }
}
