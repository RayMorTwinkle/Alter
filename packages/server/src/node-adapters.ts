import type { IncomingMessage } from "node:http";
import { adapterPresets, record } from "@alter/adapters";
import { nodeCapability, type AlterApp } from "@alter/core";
import type { AdapterManagement, NodeAdapterSummary } from "@alter/node-protocol";
import { body } from "./http.ts";
import { HttpError } from "./static.ts";

const effect = (value: unknown) => value === "read" || value === "write" || value === "irreversible";
const toolName = (value: unknown) => typeof value === "string" && /^[a-z0-9_]{1,63}$/.test(value);
const only = (obj: Record<string, unknown>, fields: string[]) => Object.keys(obj).every(k => fields.includes(k));

// Only summaries cross the management boundary. Reject extra top-level/tool fields
// (e.g. a peer accidentally returning its full AdapterView or a create payload).
export function validAdapter(a: unknown): a is NodeAdapterSummary {
  return record(a) && only(a, ["id", "name", "kind", "capabilityId", "enabled", "state", "detail", "tools", "effects"]) &&
    typeof a.id === "string" && /^[a-z0-9-]{1,48}$/.test(a.id) && typeof a.name === "string" && !!a.name.trim() &&
    typeof a.kind === "string" && ["mcp", "cli", "http"].includes(a.kind) && typeof a.capabilityId === "string" && typeof a.enabled === "boolean" &&
    typeof a.state === "string" && ["off", "connecting", "ok", "error"].includes(a.state) && (a.detail === undefined || typeof a.detail === "string") &&
    record(a.effects) && Object.entries(a.effects).every(([k, v]) => toolName(k) && effect(v)) &&
    Array.isArray(a.tools) && a.tools.every(t => record(t) && only(t, ["name", "description", "effect", "defaultEffect", "inputSchema"]) &&
      toolName(t.name) && typeof t.description === "string" && effect(t.effect) && effect(t.defaultEffect) &&
      (t.inputSchema === undefined || record(t.inputSchema))) && new Set(a.tools.map(t => t.name)).size === a.tools.length;
}
export function validAdapters(value: unknown): value is NodeAdapterSummary[] {
  return Array.isArray(value) && value.every(validAdapter) && new Set(value.map(a => a.id)).size === value.length;
}

export async function nodeAdapterRoute(nodes: AlterApp["nodes"], path: string, req: IncomingMessage) {
  if (path === "/api/nodes/adapter-presets" && req.method === "GET") return { status: 200, data: adapterPresets };
  const [, , , node, , item, suffix] = path.split("/");
  const method = req.method;
  if (!node || !/^\/api\/nodes\/[^/]+\/adapters(?:\/[^/]+){0,2}$/.test(path)) throw new HttpError(404, "Unknown endpoint");
  if (!item && method === "GET") {
    const known = (await nodes.all()).find(n => n.id === node);
    if (!known) throw new HttpError(404, "Unknown node");
    return { status: 200, data: { online: known.online, adapters: known.adapters ?? [] } };
  }
  let command: AdapterManagement;
  if (!item && method === "POST") command = { action: "create", payload: await body(req) };
  else if (item && suffix === "refresh" && method === "POST") command = { action: "refresh", adapterId: item };
  else if (item === "presets" && suffix && method === "POST") command = { action: "preset.create", presetId: suffix, payload: await body(req) };
  else if (item && !suffix && method === "PATCH") command = { action: "patch", adapterId: item, payload: await body(req) };
  else if (item && !suffix && method === "DELETE") command = { action: "remove", adapterId: item };
  else throw new HttpError(404, "Unknown endpoint");
  const data = await nodes.manageAdapters(node, command);
  if (command.action === "remove") return { status: 204 };
  if (!validAdapter(data)) throw new HttpError(502, "Invalid node adapter summary");
  const status = command.action === "create" || command.action === "preset.create" ? 201 : 200;
  return { status, data: { ...data, capabilityId: nodeCapability(node, data.id) } };
}
