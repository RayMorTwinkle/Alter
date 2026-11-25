import type { Effect } from "@alter/node-protocol";
import { stdioRpc } from "./rpc.ts";
import type { HarnessAdapter } from "./types.ts";

type Capabilities = { loadSession?: boolean; sessionCapabilities?: { list?: object; resume?: object; close?: object } };
type ConfigOption = { id: string; options?: { value?: string; options?: { value: string }[] }[] };
type ToolCall = { toolCallId: string; title?: string; kind?: string; rawInput?: unknown; status?: string;
  rawOutput?: unknown; content?: { type: string; content?: { type: string; text?: string } }[] };
type Update = { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk"; messageId?: string; content: { type: string; text?: string } }
  | (ToolCall & { sessionUpdate: "tool_call" | "tool_call_update" });
type Permission = { sessionId: string; toolCall: ToolCall; options: { kind: string; optionId: string }[] };

export function acpArgs(harness: string) { return harness === "dsh" ? ["--profile", "acp"] : ["acp"]; }

export async function initializeAcp(rpc: ReturnType<typeof stdioRpc>) {
  const init = await rpc.request<{ protocolVersion: number; agentCapabilities?: Capabilities }>("initialize", {
    protocolVersion: 1, clientInfo: { name: "alter-node", version: "1" },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  if (init.protocolVersion !== 1) throw new Error("代理不支持 ACP v1");
  return init.agentCapabilities ?? {};
}

function toolEffect(kind?: string): Effect {
  if (kind === "read" || kind === "search" || kind === "fetch") return "read";
  if (kind === "edit" || kind === "move") return "write";
  return "irreversible";
}

export const acp: HarnessAdapter = {
  start(task, sink) {
    let sessionId = "", stopping = false, canClose = false;
    let prompt: Promise<{ stopReason: string }> | undefined;
    let permissions = new AbortController();
    let lastId: string | undefined, body = "";
    const tools = new Map<string, ToolCall>();
    async function permission(p: Permission) {
      if (!prompt || stopping || p.sessionId !== sessionId) return { outcome: { outcome: "cancelled" } };
      const tool = { ...tools.get(p.toolCall.toolCallId), ...p.toolCall };
      const effect = toolEffect(tool.kind);
      const automatic = task.permission === "full" || (task.permission === "auto" && (effect === "read" || tool.kind === "edit"));
      const { signal } = permissions;
      const allow = automatic || (await sink.approve(tool.title || tool.kind || "tool", tool.rawInput ?? tool, signal, effect)).decision !== "deny";
      const selected = p.options.find(o => o.kind === (allow ? "allow_once" : "reject_once"));
      return { outcome: selected && !signal.aborted && !stopping ? { outcome: "selected", optionId: selected.optionId } : { outcome: "cancelled" } };
    }
    function update(u: Update) {
      if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        const call = { ...tools.get(u.toolCallId), ...u };
        const tool = call.title || call.kind || call.toolCallId;
        tools.set(call.toolCallId, call);
        if (u.sessionUpdate === "tool_call") sink.event({ kind: "tool_call", tool, args: call.rawInput });
        if (u.sessionUpdate === "tool_call_update" || call.status === "completed" || call.status === "failed") {
          const parts = call.content?.flatMap(b => b.content?.type === "text" && b.content.text ? [b.content.text] : []);
          sink.event({ kind: "tool_result", tool, isError: call.status === "failed",
            text: parts?.join("\n") || (typeof call.rawOutput === "string" ? call.rawOutput : JSON.stringify(call.rawOutput ?? call.content)) });
        }
        if (lastId === undefined) body = "";
      } else if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk") {
        if (u.content?.type !== "text" || !u.content.text) return;
        const text = u.content.text;
        if (u.sessionUpdate === "agent_thought_chunk") sink.event({ kind: "thinking", text });
        if (u.sessionUpdate === "agent_message_chunk") {
          if (u.messageId !== lastId) body = "";
          lastId = u.messageId; body += text;
          sink.assistant(body); sink.event({ kind: "text", text });
        }
      }
    }
    const rpc = stdioRpc(task.executable, acpArgs(task.harness), task.cwd, true, async (method, params, request) => {
      if (request && method === "session/request_permission") return permission(params as Permission);
      if (!request && method === "session/update" && prompt && !stopping) {
        const p = params as { sessionId: string; update: Update };
        if (p.sessionId === sessionId) update(p.update);
      }
    });
    async function message(text: string) {
      if (stopping) return;
      tools.clear(); body = ""; lastId = undefined;
      permissions = new AbortController();
      prompt = rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      const { stopReason } = await prompt.finally(() => { prompt = undefined; permissions.abort(); });
      if (stopping) return;
      if (stopReason === "end_turn") sink.turn({ status: "completed" });
      else if (stopReason === "cancelled") sink.turn({ status: "interrupted", reason: "代理取消本轮" });
      else sink.turn({ status: "failed", reason: "代理未完成本轮（" + stopReason + "）" });
    }
    void (async () => {
      const capabilities = await initializeAcp(rpc);
      if (stopping) return;
      canClose = !!capabilities.sessionCapabilities?.close;
      const params = { cwd: task.cwd, mcpServers: [{ name: "alter", ...task.finish, env: [] }] };
      let result: { sessionId?: string; configOptions?: ConfigOption[] };
      if (task.resume) {
        const method = capabilities.sessionCapabilities?.resume ? "session/resume" : capabilities.loadSession ? "session/load" : undefined;
        if (!method) throw new Error("代理不支持续接会话");
        result = await rpc.request(method, { ...params, sessionId: task.resume });
        sessionId = task.resume;
      } else {
        result = await rpc.request("session/new", params);
        if (!result.sessionId) throw new Error("session/new 缺少 sessionId");
        sessionId = result.sessionId;
      }
      if (stopping) return;
      sink.session(sessionId);
      let options = result.configOptions ?? [];
      if (task.model && !task.resume) {
        if (!options.some(o => o.id === "model")) throw new Error("代理未提供 model 配置项");
        const changed = await rpc.request<{ configOptions: ConfigOption[] }>("session/set_config_option", { sessionId, configId: "model", value: task.model });
        options = changed.configOptions ?? options;
      }
      const effort = options.find(o => o.id === "reasoning_effort");
      if (!stopping && effort && task.thinking) {
        const values = effort.options?.flatMap(o => o.options?.map(v => v.value) ?? [o.value]);
        const value = task.thinking === "medium" && values && !values.includes("medium") && values.includes("low") ? "low" : task.thinking;
        await rpc.request("session/set_config_option", { sessionId, configId: effort.id, value });
      }
      await message(task.brief);
    })().catch(err => { if (!stopping) sink.turn({ status: "failed", reason: String(err) }); });
    return { message, async stop(interrupt) {
      stopping = true; permissions.abort();
      if (interrupt && prompt) rpc.notify("session/cancel", { sessionId });
      const grace = prompt ?? (canClose && sessionId ? rpc.request("session/close", { sessionId }) : undefined);
      await rpc.close(grace);
    } };
  },
};
