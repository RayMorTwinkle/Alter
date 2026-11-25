// A stand-in for the executable, including the SDK's stdio control channel.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [provider, ...args] = process.argv.slice(2);
if (args[0] === "--echo-argv") { console.log(JSON.stringify(args.slice(1))); process.exit(0); }
if (args.includes("--version")) { console.log(provider + " 1.2.3"); process.exit(0); }
const trace = m => appendFileSync("trace.jsonl", JSON.stringify(m) + "\n");
trace({ args });
const send = msg => process.stdout.write(JSON.stringify(msg) + "\r\n");
let thread = "native-thread", turn = 0, brief = "", requests = 0, finish;
function assistant(text) {
  if (provider === "claude") send({ type: "assistant", parent_tool_use_id: null, uuid: crypto.randomUUID(),
    session_id: thread, message: { id: "a", role: "assistant", type: "message", content: [{ type: "text", text }] } });
  else {
    const base = { threadId: thread, turnId: String(turn), itemId: "a" };
    send({ method: "item/agentMessage/delta", params: { ...base, delta: text } });
    send({ method: "item/completed", params: { ...base, item: { type: "agentMessage", id: "a", text } } });
  }
}
function end() {
  if (provider === "claude") send({ type: "result", session_id: thread, subtype: "success", is_error: brief === "api-error",
    terminal_reason: brief === "api-error" ? "api_error" : "completed", result: brief === "api-error" ? "HTTP 429" : "结果备选",
    usage: { input_tokens: 7, output_tokens: 2 }, total_cost_usd: 0, uuid: crypto.randomUUID() });
  else send({ method: "turn/completed", params: { threadId: thread, turn: { id: String(turn), status: "completed" } } });
}
async function report() {
  const client = new Client({ name: "fake-agent", version: "1" });
  try {
    await client.connect(new StdioClientTransport(finish));
    const reply = await client.callTool({ name: "finish", arguments: { summary: "结构化报告", refs: [{ kind: "file", ref: "a.txt" }] } });
    if (reply.isError) throw Error("finish failed");
  } finally { await client.close(); }
}
async function execute() {
  if (brief.startsWith("finish")) await report();
  if (brief === "offline") {
    assistant("即将断网");
    while (!existsSync("continue")) await new Promise(r => setTimeout(r, 10));
  }
  if (brief === "hold") {
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "ignore" });
    const pids = [process.pid, grandchild.pid];
    if (process.platform === "win32") pids.unshift(process.ppid); // The .cmd wrapper.
    writeFileSync("pids.json", JSON.stringify(pids));
    assistant("等待"); return;
  }
  if (brief === "ask" || brief === "ask-edit") {
    requests++;
    if (provider === "claude") send({ type: "control_request", request_id: "permission-" + requests,
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo hi" }, tool_use_id: "tool-1" } });
    else send({ method: brief === "ask" ? "item/commandExecution/requestApproval" : "item/fileChange/requestApproval",
      id: "approval-" + requests, params: { threadId: thread, turnId: String(turn), command: "echo hi" } });
    return;
  }
  assistant("正文 " + brief);
  if (brief === "finish-crash") { process.stderr.write("模拟崩溃\n"); process.exit(9); }
  end();
}

if (provider === "claude") {
  thread = args.find(arg => arg.startsWith("--resume="))?.slice(9) || thread;
  finish = JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers.alter;
} else {
  const value = key => JSON.parse(args.find(arg => arg.startsWith("mcp_servers.alter." + key + "=")).split("=").slice(1).join("="));
  finish = { command: value("command"), args: value("args") };
}
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const m = JSON.parse(line); trace(m);
  if (provider === "claude") {
    if (m.type === "control_request") send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
    else if (m.type === "user") { turn++; brief = m.message.content; await execute(); }
    else if (m.type === "control_response") { assistant(m.response.response.behavior + " " + (m.response.response.message || "")); end(); }
  } else {
    const reply = result => send({ id: m.id, result });
    if (["initialize", "turn/steer", "turn/interrupt"].includes(m.method)) reply({});
    if (m.method === "thread/start" || m.method === "thread/resume") { thread = m.params.threadId || thread; reply({ thread: { id: thread } }); }
    if (m.method === "turn/start") {
      turn++; brief = m.params.input[0].text; reply({ turn: { id: String(turn) } });
      send({ method: "turn/started", params: { threadId: thread, turn: { id: String(turn) } } });
      await execute();
    }
    if (!m.method && m.result?.decision) { assistant(m.result.decision); end(); }
  }
}
