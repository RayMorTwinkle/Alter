import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { PassThrough } from "node:stream";
import { killTree, spawnTree } from "../spawn.ts";
import type { HarnessAdapter } from "./types.ts";

export const claude: HarnessAdapter = {
  start(task, sink) {
    const input = new PassThrough({ objectMode: true });
    let sessionId = task.resume ?? "";
    const send = (text: string) => {
      input.write({ type: "user", session_id: sessionId, parent_tool_use_id: null,
        message: { role: "user", content: text } } satisfies SDKUserMessage);
    };
    let child: ReturnType<typeof spawnTree> | undefined;
    const options = {
      cwd: task.cwd, pathToClaudeCodeExecutable: task.executable, resume: task.resume,
      permissionMode: ({ restricted: "default", auto: "acceptEdits", full: "bypassPermissions" } as const)[task.permission],
      allowDangerouslySkipPermissions: task.permission === "full", effort: task.thinking,
      mcpServers: { alter: task.finish }, strictMcpConfig: true,
    };
    let lastText = "", assistantError = "", stderr = "", stopped = false;
    const run = query({ prompt: input as AsyncIterable<SDKUserMessage>, options: { ...options,
      spawnClaudeCodeProcess(opts) {
        if (stopped) throw new Error("任务已停止");
        child = spawnTree(opts.command, opts.args, opts.cwd, opts.env);
        child.stderr.setEncoding("utf8").on("data", s => { stderr = (stderr + s).slice(-2000); });
        return child;
      },
      canUseTool: task.permission === "full" ? undefined : async (tool, args, { signal, toolUseID }) => {
        const answer = await sink.approve(tool, args, signal);
        return answer.decision === "deny" ? { behavior: "deny", message: answer.note || "用户拒绝", toolUseID }
          : { behavior: "allow", updatedInput: args, toolUseID };
      },
    } });
    send(task.brief);
    void (async () => {
      for await (const msg of run) {
        if (stopped) break;
        if ("parent_tool_use_id" in msg && msg.parent_tool_use_id) continue;
        if (msg.session_id) { sessionId = msg.session_id; sink.session(sessionId); }
        if (msg.type === "assistant") {
          if (msg.error) assistantError = msg.error;
          const body: string[] = [];
          for (const block of msg.message.content) {
            if (block.type === "text") { body.push(block.text); sink.event({ kind: "text", text: block.text }); }
            if (block.type === "thinking") sink.event({ kind: "thinking", text: block.thinking });
            if (block.type === "tool_use") sink.event({ kind: "tool_call", tool: block.name, args: block.input });
          }
          if (body.join("\n").trim()) { lastText = body.join("\n"); sink.assistant(lastText); }
        } else if (msg.type === "user" && Array.isArray(msg.message.content)) {
          for (const b of msg.message.content) if (b.type === "tool_result")
            sink.event({ kind: "tool_result", text: typeof b.content === "string" ? b.content : JSON.stringify(b.content), isError: b.is_error });
        } else if (msg.type === "result") {
          const reason = msg.terminal_reason;
          const failed = msg.subtype !== "success" || msg.is_error || assistantError ||
            (reason && reason !== "completed") || (msg.api_error_status ?? 0) >= 400;
          if (!failed && !lastText && msg.subtype === "success" && msg.result.trim()) {
            sink.assistant(msg.result); sink.event({ kind: "text", text: msg.result });
          }
          const detail = msg.subtype === "success" ? msg.result : msg.errors?.join("\n");
          const interrupted = reason === "aborted_streaming" || reason === "aborted_tools";
          const error = [reason, assistantError, detail || msg.subtype].filter(Boolean).join(" ");
          lastText = ""; assistantError = "";
          sink.turn({ status: interrupted ? "interrupted" : failed ? "failed" : "completed", reason: failed ? error : undefined,
            usage: { inputTokens: msg.usage?.input_tokens, outputTokens: msg.usage?.output_tokens,
              cacheReadTokens: msg.usage?.cache_read_input_tokens, costUsd: msg.total_cost_usd } });
        }
      }
      if (!stopped) sink.turn({ status: "failed", reason: "Claude 消息流在轮结束前关闭" });
    })().catch(err => { if (!stopped) sink.turn({ status: "failed", reason: [String(err), stderr.trim()].filter(Boolean).join("\n") }); });
    return { message: send, async stop(interrupt) {
      stopped = true;
      try { if (child) await killTree(child, interrupt ? run.interrupt() : undefined); }
      finally { input.end(); run.close(); }
    } };
  },
};
