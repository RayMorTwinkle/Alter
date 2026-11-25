import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

export async function runAcp({ provider, args, trace, report }) {
  assert.deepEqual(args, provider === "dsh" ? ["--profile", "acp"] : ["acp"]);
  const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\r\n");
  let sessionId, server, prompt, brief;
  const configOptions = [{ id: "model" }, { id: "reasoning_effort", options: ["off", "low", "high", "max"].map(value => ({ value })) }];
  const notify = update => send({ method: "session/update", params: { sessionId, update } });
  const text = (s, messageId) => notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: s } });
  const end = stopReason => send({ id: prompt, result: { stopReason } });
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const m = JSON.parse(line); trace(m);
    assert.equal(m.jsonrpc, "2.0");
    const p = m.params, reply = result => send({ id: m.id, result });
    if (m.method === "initialize") {
      assert.deepEqual(p.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
      reply({ protocolVersion: 1, agentCapabilities: { loadSession: true,
        sessionCapabilities: { close: {}, list: {}, ...(!existsSync("load-only") && { resume: {} }) } } });
    } else if (m.method === "session/list") {
      writeFileSync("listing.pid", String(process.pid));
      if (existsSync("hang")) continue;
      const pages = JSON.parse(readFileSync("pages.json", "utf8"));
      const i = Number(p.cursor ?? 0);
      reply({ sessions: pages[i], ...(pages[i + 1] && { nextCursor: String(i + 1) }) });
    } else if (["session/new", "session/load", "session/resume"].includes(m.method)) {
      sessionId = p.sessionId ?? "new-acp";
      if (sessionId === "busy") { send({ id: m.id, error: { code: -32603, message: 'session "busy" is already owned by an active write handle' } }); continue; }
      [server] = p.mcpServers;
      assert.equal(server.name, "alter");
      assert.deepEqual(server.env, []);
      if (p.sessionId) text("旧会话正文", "old");
      reply({ ...(!p.sessionId && { sessionId }), configOptions });
      notify({ sessionUpdate: "available_commands_update", availableCommands: [] });
    } else if (m.method === "session/set_config_option") reply({ configOptions });
    else if (m.method === "session/close") reply({});
    else if (m.method === "session/cancel") { assert.equal(m.id, undefined); end("cancelled"); }
    else if (m.method === "session/prompt") {
      assert.equal(p.sessionId, sessionId);
      prompt = m.id; brief = p.prompt[0].text;
      if (brief.startsWith("ask-") || brief === "finish-ask") {
        if (brief === "finish-ask") await report({ command: server.command, args: server.args });
        const kind = brief === "finish-ask" ? "execute" : brief.slice(4);
        const toolCall = { toolCallId: "tool", kind, title: "原生工具", rawInput: { command: "test" } };
        notify({ ...toolCall, sessionUpdate: "tool_call" });
        const options = [{ kind: "allow_always", optionId: "never-select" }, { kind: "reject_once", optionId: "no" }];
        if (kind !== "missing") options.push({ kind: "allow_once", optionId: "yes" });
        send({ id: "approval", method: "session/request_permission", params: { sessionId, toolCall, options } });
        continue;
      }
      if (brief === "hold") {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "ignore" });
        const pids = [process.pid, child.pid];
        if (process.platform === "win32") pids.unshift(process.ppid);
        writeFileSync("pids.json", JSON.stringify(pids));
        text("等待"); continue;
      }
      text("前言", "first");
      notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考" } });
      notify({ sessionUpdate: "tool_call", toolCallId: "read", title: "读文件", kind: "read", rawInput: { path: "a" } });
      notify({ sessionUpdate: "tool_call_update", toolCallId: "read", status: "completed", content: [{ type: "content", content: { type: "text", text: "文件内容" } }] });
      text("正文 ", "last"); text(brief, "last");
      if (brief.startsWith("finish")) await report({ command: server.command, args: server.args });
      if (brief === "finish-crash") process.exit(9);
      end(["refusal", "max_tokens", "cancelled"].includes(brief) ? brief : "end_turn");
    } else if (m.id === "approval") {
      text(m.result.outcome.optionId ?? m.result.outcome.outcome);
      end("end_turn");
    } else throw Error("unexpected frame");
  }
}
