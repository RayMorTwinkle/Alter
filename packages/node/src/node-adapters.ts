import { restrictWindowsFile } from "./config.ts";
import { AdapterError, adapterPresets, openAdapterEngine, openSecrets, presetConfig, record, type AdapterView } from "@alter/adapters";
import type { AdapterManagement, AdapterManagementResult, NodeAdapterSummary, ToolCall, ToolResult } from "@alter/node-protocol";

function summary({ id, name, kind, capabilityId, enabled, status, tools, effects }: AdapterView): NodeAdapterSummary {
  return { id, name, kind, capabilityId, enabled, ...status, tools, effects };
}

export function nodeAdapters(dir: string) {
  const protectFile = process.platform === "win32" ? restrictWindowsFile : undefined;
  const secrets = openSecrets(dir, "adapter-secrets.json", "adapter.key", protectFile);
  const engine = openAdapterEngine(dir, secrets, { redactOutput: true, maxToolName: 31, protectFile });
  const list = () => engine.list().map(summary);
  async function manage({ action, adapterId = "", presetId = "", payload = {} }: AdapterManagement, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!record(payload)) throw new AdapterError(400, "Expected an adapter object");
    switch (action) {
      case "list": return list();
      case "presets": return adapterPresets;
      case "create": return summary(await engine.create(payload, signal));
      case "preset.create": return summary(await engine.create(presetConfig(presetId, payload), signal));
      case "patch": return summary(await engine.patch(adapterId, payload, signal));
      case "refresh": return summary(await engine.refresh(adapterId, signal));
      case "remove": await engine.remove(adapterId, signal); return null;
      default: throw new AdapterError(400, "Unknown adapter action");
    }
  }
  async function managementResult(m: AdapterManagement & { requestId: string }, signal: AbortSignal): Promise<AdapterManagementResult> {
    const base = { type: "adapters.manage.result" as const, requestId: m.requestId };
    try { return { ...base, ok: true, data: await manage(m, signal) }; }
    catch (error) {
      return { ...base, ok: false, status: error instanceof AdapterError ? error.status : 500,
        error: error instanceof AdapterError ? error.message : "Node adapter management failed" };
    }
  }
  async function call(m: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const base = { type: "tool.result" as const, callId: m.callId };
    try {
      const tool = list().find(a => a.id === m.adapterId)?.tools.find(t => t.name === m.toolName);
      if (!tool || (m.expectedEffect && tool.effect !== m.expectedEffect)) throw new AdapterError(409, "Adapter tool changed");
      const result = await engine.call(m.adapterId, m.toolName, m.args, signal);
      return { ...base, ok: true, content: result.output.flatMap(p => p.type === "text" ? [p.text] : []).join("\n"), isError: result.isError };
    } catch (error) {
      return { ...base, ok: false, error: error instanceof AdapterError ? error.message : "Node adapter call failed" };
    }
  }
  async function setEffect(id: string, tool: string, effect: string) { return summary(await engine.setEffect(id, tool, effect)); }
  return { setEffect, start: engine.start, close: engine.close, subscribe: engine.subscribe, list, manage, managementResult, call };
}
