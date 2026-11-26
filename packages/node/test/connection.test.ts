import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, expect, test, vi } from "vitest";
import type { ApprovalRequest, HarnessId, Hello, HubMessage, NodeMessage, TaskEnd, TaskStart } from "@alter/node-protocol";
import { runNode } from "../src/connection.ts";
import { configDir, directory, pair, saveConfig } from "../src/config.ts";
import { workspace, until } from "./helpers.ts";
import { killTree } from "../src/spawn.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
function processExited(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw err;
  }
}
async function setup(timeoutMs?: number, retryMs = 30, listTimeoutMs?: number, prepare?: (dir: string) => void) {
  const f = workspace();
  const hub = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(hub, "listening");
  const config = pair(f.dir, "http://127.0.0.1:" + (hub.address() as AddressInfo).port, "user.fake-secret", "测试电脑", [f.root]);
  let client: WebSocket, ackSeq: Record<string, number> = {};
  const messages: NodeMessage[] = [];
  const connections: { path?: string; auth?: string }[] = [];
  const send = (m: HubMessage) => client.send(JSON.stringify(m));
  hub.on("connection", (socket, req) => {
    client = socket;
    connections.push({ path: req.url, auth: req.headers.authorization });
    socket.on("message", raw => {
      const m: NodeMessage = JSON.parse(raw.toString()); messages.push(m);
      if (m.type === "hello") send({ type: "welcome", protocol: 1, userId: "user", ackSeq });
    });
  });
  prepare?.(f.dir);
  const node = runNode(f.dir, f.harnesses, { retryMs, timeoutMs, listTimeoutMs });
  cleanup.push(async () => {
    await node.stop();
    for (const s of hub.clients) s.terminate();
    await new Promise<void>(r => hub.close(() => r()));
    rmSync(f.base, { recursive: true, force: true });
  });
  const hello = await until(() => messages.find((m): m is Hello => m.type === "hello"));
  const start = (taskId: string, brief: string, harness: HarnessId = "codex", rest: Partial<TaskStart> = {}) =>
    send({ type: "task.start", taskId, harness, permission: "restricted", brief, ...rest });
  const end = (id: string) => until(() => messages.find((m): m is TaskEnd => m.type === "task.end" && m.taskId === id));
  const approval = (id: string) => until(() => messages.find((m): m is ApprovalRequest => m.type === "approval.request" && m.taskId === id));
  return { ...f, node, messages, config, connections, send, start, end, approval, hello,
    reconnect(acks: Record<string, number>) { ackSeq = acks; client.terminate(); } };
}

test("hello, ping, roots and unavailable harness", async () => {
  const f = await setup();
  expect(f.connections).toEqual([{ path: "/api/node/connect", auth: "Bearer user.fake-secret" }]);
  expect(f.hello).toMatchObject({ protocol: 1, nodeId: f.config.nodeId, roots: f.config.roots, tasks: [] });
  expect(JSON.stringify(f.hello)).not.toContain("executable");
  f.send({ type: "ping", at: 123 }); await until(() => f.messages.find(m => m.type === "pong" && m.at === 123));
  f.start("escape", "run", "codex", { cwd: f.base });
  expect(await f.end("escape")).toMatchObject({ status: "failed", reportSource: "failure", report: { summary: expect.stringContaining("roots") } });
  f.harnesses.find(h => h.id === "opencode")!.available = false;
  f.start("missing", "run", "opencode");
  expect((await f.end("missing")).report.summary).toContain("不可用");
  expect(existsSync(path.join(f.root, "trace.jsonl"))).toBe(false);
});

test("Codex bridges approval, replays the pending request with its original seq, queues the next turn and resumes", async () => {
  const f = await setup();
  f.start("task", "ask", "codex", { resume: "previous" });
  const req = await f.approval("task");
  expect(req).toMatchObject({ tool: "exec_command", effect: "irreversible", args: { command: "echo hi" } });
  f.send({ type: "ack", taskId: "task", seq: req.seq });
  f.reconnect({ task: req.seq });
  await until(() => f.messages.filter(m => m.type === "approval.request")[1]);
  expect(f.messages.filter(m => m.type === "approval.request")).toEqual([req, req]);
  expect(f.messages.filter(m => m.type === "hello").at(-1)).toMatchObject({ tasks: [{ taskId: "task", state: "running", lastSeq: req.seq }] });
  f.send({ type: "task.message", taskId: "task", text: "补充" });
  f.send({ type: "approval.answer", taskId: "task", requestId: req.requestId, decision: "always" });
  const end = await f.end("task");
  expect(end).toMatchObject({ status: "completed", nativeSessionId: "previous", reportSource: "last_message", report: { summary: "正文 补充" } });
  const trace = readFileSync(path.join(f.root, "trace.jsonl"), "utf8");
  expect(trace).toContain('"method":"thread/resume"'); expect(trace).toContain('"sandbox":"read-only"');
  expect(trace).toContain('"approvalPolicy":"untrusted"'); expect(trace).toContain('"decision":"accept"');
  const before = f.messages.length;
  f.reconnect({ task: req.seq });
  await until(() => f.messages.slice(before).find(m => m.type === "task.end"));
  const replay = f.messages.slice(before).filter(m => "seq" in m);
  expect(replay.map(m => m.seq)).toEqual(Array.from({ length: end.seq - req.seq }, (_, i) => i + req.seq + 1));
  f.send({ type: "ack", taskId: "task", seq: end.seq });
  await until(() => existsSync(path.join(f.dir, "outbox/task.done")) || undefined);
  f.start("task", "duplicate");
  f.send({ type: "ping", at: 77 }); await until(() => f.messages.find(m => m.type === "pong" && m.at === 77));
  expect(existsSync(path.join(f.dir, "outbox/task.jsonl"))).toBe(false);
  expect(new Set(f.messages.filter(m => m.type === "task.end").map(m => m.seq)).size).toBe(1);
});

test.each(["codex", "claude-code"] as const)("%s drives native stdio, denial, finish MCP, and a crash", async harness => {
  const f = await setup();
  f.start("denied", "ask-edit", harness, { resume: "old", permission: "auto" });
  const req = await f.approval("denied");
  f.send({ type: "approval.answer", taskId: "denied", requestId: req.requestId, decision: "deny", note: "不要执行" });
  const denied = await f.end("denied");
  expect(denied).toMatchObject({ nativeSessionId: "old", reportSource: "last_message" });
  expect(denied.report.summary.trim()).toBe(harness === "codex" ? "decline" : "deny 不要执行");
  const trace = readFileSync(path.join(f.root, "trace.jsonl"), "utf8");
  expect(trace).toContain(harness === "codex" ? '"method":"turn/steer"' : "acceptEdits");
  expect(trace).toContain("不要执行");
  f.start("report", "finish-ok", harness, { permission: "full" });
  expect(await f.end("report")).toMatchObject({ status: "completed", reportSource: "finish",
    report: { summary: "结构化报告", refs: [{ kind: "file", ref: "a.txt" }] } });
  f.start("crash", "finish-crash", harness);
  expect(await f.end("crash")).toMatchObject({ status: "failed", reportSource: "failure", report: { summary: expect.stringContaining("正文 finish-crash") } });
});

test("Claude uses streaming input for a follow-up and checks error flags on success results", async () => {
  const f = await setup();
  f.start("a", "ask", "claude-code");
  const r = await f.approval("a");
  f.send({ type: "task.message", taskId: "a", text: "第二轮" });
  f.send({ type: "approval.answer", taskId: "a", requestId: r.requestId, decision: "once" });
  expect(await f.end("a")).toMatchObject({ status: "completed", report: { summary: "正文 第二轮" } });
  f.start("bad", "api-error", "claude-code");
  expect(await f.end("bad")).toMatchObject({ status: "failed", reportSource: "failure", report: { summary: expect.stringContaining("HTTP 429") } });
});

test.each(["codex", "claude-code", "dsh", "opencode"] as const)("stop kills the %s process tree before the report", async harness => {
  const f = await setup();
  f.start("long", "hold", harness);
  await until(() => f.messages.find(m => m.type === "task.event" && m.text === "等待"));
  const pids: number[] = JSON.parse(readFileSync(path.join(f.root, "pids.json"), "utf8"));
  expect(pids).toHaveLength(process.platform === "win32" ? 3 : 2);
  for (const pid of pids) { expect(pid).toBeGreaterThan(0); process.kill(pid, 0); }
  f.send({ type: "task.stop", taskId: "long", reason: "手动停止" });
  expect(await f.end("long")).toMatchObject({ status: "interrupted", reportSource: "failure", report: { summary: "手动停止\n等待" } });
  if (process.platform !== "win32") expect(readFileSync(path.join(f.root, "trace.jsonl"), "utf8"))
    .toContain(harness === "codex" ? '"method":"turn/interrupt"' : harness === "claude-code" ? '"subtype":"interrupt"' : '"method":"session/cancel"');
  await until(() => pids.every(processExited) || undefined);
});

test("timeout settles exactly once", async () => {
  const f = await setup(250);
  f.start("slow", "ask");
  const end = await f.end("slow");
  expect(end).toMatchObject({ status: "failed", reportSource: "failure", report: { summary: expect.stringContaining("超时") } });
  expect(f.messages.filter(m => m.type === "task.end")).toHaveLength(1);
});

test("an offline terminal report is persisted before welcome and replayed from the hub cursor", async () => {
  const f = await setup(undefined, 400);
  f.start("off", "offline");
  const prefix = await until(() => f.messages.find(m => m.type === "task.event" && m.text === "即将断网"));
  if (!("seq" in prefix)) throw Error("缺少序号");
  f.reconnect({ off: prefix.seq });
  writeFileSync(path.join(f.root, "continue"), "");
  const result = await f.end("off");
  const hello = f.messages.filter(m => m.type === "hello").at(-1)!;
  expect(hello.tasks).toEqual([{ taskId: "off", state: "ended", lastSeq: result.seq }]);
  const deployed = f.messages.filter(m => "taskId" in m && m.taskId === "off");
  expect(deployed.map(m => "seq" in m && m.seq)).toEqual(Array.from({ length: result.seq }, (_, i) => i + 1));
  expect(result.report.summary).toBe("正文 offline");
});

test("node shutdown interrupts a task and persists the terminal report", async () => {
  const f = await setup();
  f.start("exit", "hold");
  await until(() => f.messages.find(m => m.type === "task.event" && m.text === "等待"));
  await f.node.stop();
  const entries = readFileSync(path.join(f.dir, "outbox/exit.jsonl"), "utf8").trimEnd().split("\n").map(s => JSON.parse(s));
  expect(entries.filter(e => e.type === "task.end")).toMatchObject([{ status: "interrupted", reportSource: "failure" }]);
  const pids: number[] = JSON.parse(readFileSync(path.join(f.root, "pids.json"), "utf8"));
  await until(() => pids.every(processExited) || undefined);
});

test("silent hub triggers reconnect and rejection terminates without leaking the supplied reason", async () => {
  const f = workspace();
  const hub = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(hub, "listening");
  try {
    pair(f.dir, "http://127.0.0.1:" + (hub.address() as AddressInfo).port, "user.secret");
    let handshakes = 0;
    hub.on("connection", socket => socket.once("message", () => {
      if (++handshakes === 2) socket.send(JSON.stringify({ type: "rejected", reason: "user.secret" }));
    }));
    const node = runNode(f.dir, f.harnesses, { retryMs: 10, idleMs: 50 });
    const failure = await node.done.then(() => "", err => String(err));
    expect(failure).toContain("拒绝"); expect(failure).not.toContain("user.secret");
    expect(handshakes).toBe(2);
  } finally {
    for (const socket of hub.clients) socket.terminate();
    await new Promise<void>(resolve => hub.close(() => resolve()));
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("CLI run advertises detected shims, reports live status and drains on shutdown", async () => {
  const f = workspace(), cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const env = { ...process.env, HOME: f.base, USERPROFILE: f.base, APPDATA: f.base,
    PATH: f.bin + path.delimiter + path.dirname(process.execPath) };
  const hub = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(hub, "listening");
  const dir = configDir(process.platform, f.base, f.base);
  pair(dir, "http://127.0.0.1:" + (hub.address() as AddressInfo).port, "user.fake-secret", "CLI", [f.root]);
  const wire: NodeMessage[] = [];
  hub.on("connection", socket => socket.on("message", raw => {
    const m: NodeMessage = JSON.parse(raw.toString()); wire.push(m);
    if (m.type === "hello") {
      socket.send(JSON.stringify({ type: "welcome", protocol: 1, userId: "user", ackSeq: {} }));
      socket.send(JSON.stringify({ type: "task.start", taskId: "cli", harness: "codex", brief: "hold", permission: "auto" }));
    }
  }));
  const child = spawn(process.execPath, [cli, "run"], { env, stdio: "pipe" });
  const exited = once(child, "exit");
  try {
    await until(() => wire.find(m => m.type === "task.event" && m.text === "等待"));
    expect(wire[0]).toMatchObject({ type: "hello", harnesses: [{ available: true, version: "1.2.3" },
      { available: true, version: "1.2.3" }, { available: true, sessions: true, version: "1.2.3" }, { available: true, sessions: true, version: "1.2.3" }] });
    expect(JSON.parse(execFileSync(process.execPath, [cli, "status"], { env, encoding: "utf8" })).state).toBe("在线");
    // Windows child.kill is a hard termination. A hub rejection exercises the CLI shutdown path.
    if (process.platform === "win32") {
      for (const socket of hub.clients) socket.send(JSON.stringify({ type: "rejected", reason: "test" }));
    } else child.kill("SIGTERM");
    expect((await exited)[0]).toBe(process.platform === "win32" ? 1 : 0);
    expect(readFileSync(path.join(dir, "outbox/cli.jsonl"), "utf8")).toContain('"status":"interrupted"');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") await killTree(child); else child.kill("SIGTERM");
      await exited;
    }
    for (const s of hub.clients) s.terminate();
    await new Promise<void>(resolve => hub.close(() => resolve())); rmSync(f.base, { recursive: true, force: true });
  }
});

test.each(["dsh", "opencode"] as const)("%s maps ACP updates, reports and stop reasons", async harness => {
  const f = await setup();
  const model = harness === "dsh" ? '["zen","deepseek-v4-flash"]' : "zen/deepseek-v4-flash";
  saveConfig(f.dir, { ...f.config, models: { [harness]: model } });
  f.reconnect({});
  const hello = await until(() => f.messages.filter(m => m.type === "hello")[1]);
  expect(hello.harnesses.find(h => h.id === harness)).toMatchObject({ sessions: true, model });
  f.start("text", "流式回复", harness, { thinking: "medium" });
  expect(await f.end("text")).toMatchObject({ nativeSessionId: "new-acp", status: "completed", reportSource: "last_message", report: { summary: "正文 流式回复" } });
  expect(f.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "thinking", text: "思考" }), expect.objectContaining({ kind: "tool_call", tool: "读文件", args: { path: "a" } }),
    expect.objectContaining({ kind: "tool_result", tool: "读文件", text: "文件内容" }),
  ]));
  const trace = readFileSync(path.join(f.root, "trace.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  expect(trace.filter(m => m.method === "session/set_config_option").map(m => m.params)).toEqual([
    { sessionId: "new-acp", configId: "model", value: model }, { sessionId: "new-acp", configId: "reasoning_effort", value: "low" },
  ]);
  for (const brief of ["finish-ok", "finish-crash", "refusal", "max_tokens", "cancelled"]) {
    f.start(brief, brief, harness);
    const e = await f.end(brief);
    if (brief === "finish-ok") expect(e).toMatchObject({ status: "completed", reportSource: "finish", report: { summary: "结构化报告", refs: [{ kind: "file", ref: "a.txt" }] } });
    else expect(e).toMatchObject({ status: brief === "cancelled" ? "interrupted" : "failed", reportSource: "failure",
      report: { summary: expect.stringContaining("正文 " + brief) } });
  }
}, 30000);

test("ACP resume, load replay, follow-up and occupied sessions", async () => {
  const f = await setup();
  saveConfig(f.dir, { ...f.config, models: { dsh: "仅新会话" } });
  for (const method of ["resume", "load"]) {
    if (method === "load") writeFileSync(path.join(f.root, "load-only"), "");
    f.start(method, "finish-ask", "dsh", { resume: "saved" });
    const req = await f.approval(method);
    f.send({ type: "task.message", taskId: method, text: "续写" });
    f.send({ type: "approval.answer", taskId: method, requestId: req.requestId, decision: "always" });
    expect(await f.end(method)).toMatchObject({ status: "completed", nativeSessionId: "saved", reportSource: "last_message", report: { summary: "正文 续写" } });
    expect(f.messages.filter(m => m.type === "task.end" && m.taskId === method)).toHaveLength(1);
    expect(readFileSync(path.join(f.root, "trace.jsonl"), "utf8")).toContain('"method":"session/' + method + '"');
    expect(f.messages.some(m => m.type === "task.event" && m.text === "旧会话正文")).toBe(false);
  }
  f.start("busy", "run", "dsh", { resume: "busy" });
  expect(await f.end("busy")).toMatchObject({ status: "failed", reportSource: "failure", report: { summary: expect.stringContaining("该会话正在原界面打开，关掉后再试") } });
  expect(readFileSync(path.join(f.root, "trace.jsonl"), "utf8")).not.toContain("session/set_config_option");
}, 30000);

test.each([
  ["restricted", "read", "read", "deny", "no"],
  ["restricted", "search", "read", "once", "yes"],
  ["auto", "read", null, null, "yes"], ["auto", "edit", null, null, "yes"], ["auto", "fetch", null, null, "yes"],
  ["auto", "move", "write", "once", "yes"], ["auto", "delete", "irreversible", "deny", "no"],
  ["auto", "execute", "irreversible", "always", "yes"],
  ["full", "execute", null, null, "yes"], ["full", "missing", null, null, "cancelled"],
] as const)("ACP permissions %s / %s", async (permission, kind, effect, decision, outcome) => {
  const f = await setup();
  f.start("ask", "ask-" + kind, "opencode", { permission });
  if (decision) {
    const req = await f.approval("ask");
    expect(req).toMatchObject({ effect, tool: "原生工具", args: { command: "test" } });
    f.send({ type: "approval.answer", taskId: "ask", requestId: req.requestId, decision });
  }
  expect(await f.end("ask")).toMatchObject({ status: "completed", report: { summary: outcome } });
  expect(f.messages.filter(m => m.type === "approval.request")).toHaveLength(decision ? 1 : 0);
});

test("sessions.list paginates, filters by real cwd and roots before sorting and limiting", async () => {
  const f = await setup();
  const root = directory(f.root), sub = path.join(root, "子目录"), escape = path.join(root, "link");
  mkdirSync(sub); symlinkSync(f.bin, escape, process.platform === "win32" ? "junction" : "dir");
  const row = (id: number, cwd = root) => ({ sessionId: String(id), cwd, updatedAt: new Date(1740000000000 + id).toISOString(), title: "会话 " + id });
  const second = path.join(f.base, "第二个 root");
  mkdirSync(second);
  saveConfig(f.dir, { ...f.config, roots: [root, directory(second)] });
  const pages = [[row(21, second), row(1000, escape), row(999, f.base), row(0)], [row(23, sub), ...Array.from({ length: 22 }, (_, i) => row(i + 1)).filter(r => r.sessionId !== "21")]];
  writeFileSync(path.join(root, "pages.json"), JSON.stringify(pages));
  async function list(requestId: string, harness: HarnessId, cwd?: string, limit?: number) {
    f.send({ type: "sessions.list", requestId, harness, cwd, limit });
    return until(() => f.messages.filter(m => m.type === "sessions.result").find(m => m.requestId === requestId));
  }
  const all = await list("all", "opencode");
  expect(all.error).toBeUndefined();
  expect(all.sessions.map(s => s.sessionId)).toEqual(Array.from({ length: 20 }, (_, i) => String(23 - i)));
  expect(all.sessions.find(s => s.sessionId === "21")?.cwd).toBe(directory(second));
  expect(all.sessions[0]).toEqual({ sessionId: "23", cwd: sub, updatedAt: 1740000000023, title: "会话 23" });
  expect((await list("exact", "opencode", root, 1)).sessions.map(s => s.sessionId)).toEqual(["22"]);
  expect(await list("outside", "opencode", escape)).toMatchObject({ sessions: [], error: expect.stringContaining("roots") });
  expect(await list("threads", "codex", root)).toMatchObject({ sessions: [{ sessionId: "codex-1", cwd: root, title: "保存的线程", updatedAt: 1790000000000 }] });
  expect(readFileSync(path.join(root, "trace.jsonl"), "utf8")).not.toContain("session/new");
});

test("a timed out sessions.list replies with an error and releases its process", async () => {
  const f = await setup(undefined, 30, process.platform === "win32" ? 4000 : 1400);
  writeFileSync(path.join(f.root, "hang"), "");
  f.send({ type: "sessions.list", requestId: "slow", harness: "opencode" });
  const pid = await until(() => existsSync(path.join(f.root, "listing.pid")) ? Number(readFileSync(path.join(f.root, "listing.pid"), "utf8")) : undefined);
  expect(await until(() => f.messages.find(m => m.type === "sessions.result"))).toMatchObject({ requestId: "slow", sessions: [], error: "列出会话超时" });
  await until(() => processExited(pid) || undefined);
});

test("manages live node adapters through the socket and local CLI, redacts outputs and restores discovery on reconnect", async () => {
  const f = await setup();
  async function manage(m: import("@alter/node-protocol").AdapterManagement) {
    const requestId = crypto.randomUUID();
    f.send({ type: "adapters.manage", requestId, ...m });
    return until(() => f.messages.filter(m => m.type === "adapters.manage.result").find(m => m.requestId === requestId));
  }
  async function call(expectedEffect: "read" | "write") {
    const callId = crypto.randomUUID();
    f.send({ type: "tool.call", callId, adapterId: "local", toolName: "run", expectedEffect, args: { args: [] } });
    return until(() => f.messages.filter(m => m.type === "tool.result").find(m => m.callId === callId));
  }
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  async function command(...args: string[]) {
    const proc = spawn(process.execPath, [cli, "adapter", ...args, "--dir", f.dir]);
    let stdout = "", stderr = "";
    proc.stdout.on("data", s => stdout += s); proc.stderr.on("data", s => stderr += s);
    expect((await once(proc, "close"))[0], stderr).toBe(0);
    return JSON.parse(stdout);
  }
  const secret = "example-private-key";
  const payload = { id: "local", name: "Laptop", kind: "cli", config: { command: process.execPath,
    help: "read token", env: { TOKEN: "{{secret:TOKEN}}" }, args: ["-p", "process.env.TOKEN"] }, secrets: { TOKEN: secret } };
  expect(await manage({ action: "create", payload })).toMatchObject({ ok: true, data: { state: "ok", tools: [{ effect: "write" }] } });
  expect(await manage({ action: "list" })).toMatchObject({ data: [{ id: "local" }] });
  expect(await manage({ action: "presets" })).toMatchObject({ data: [{ id: "github" }] });
  expect(await manage({ action: "preset.create", presetId: "github", payload: { auth: "token" } })).toMatchObject({ status: 400 });
  const github = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unavailable: " + secret));
  try {
    expect(await manage({ action: "preset.create", presetId: "github", payload: { auth: "token", token: secret } }))
      .toMatchObject({ ok: true, data: { id: "github", state: "error" } });
    expect(github).toHaveBeenCalled();
    expect(await manage({ action: "remove", adapterId: "github" })).toMatchObject({ ok: true });
  } finally { github.mockRestore(); }
  expect(await command("effect", "local", "run", "read")).toMatchObject({ effects: { run: "read" } });
  expect(await call("write")).toMatchObject({ ok: false });
  expect(await call("read")).toMatchObject({ ok: true, content: expect.stringContaining("[redacted]") });
  expect(await command("disable", "local")).toMatchObject({ state: "off" });
  expect(await command("enable", "local")).toMatchObject({ state: "ok" });
  expect(await command("refresh", "local")).toMatchObject({ state: "ok" });
  expect(await command("list")).toMatchObject([{ name: "Laptop" }]);
  f.reconnect({});
  await until(() => f.messages.filter(m => m.type === "hello")[1]?.adapters?.length || undefined);
  expect(JSON.stringify(f.messages)).not.toContain(secret);
  expect(f.messages.some(m => m.type === "adapters.state" && m.adapters.some(a => a.state === "connecting"))).toBe(true);
  for (const name of ["adapters.json", "adapter-secrets.json", "adapter.key"]) {
    const file = path.join(f.dir, name);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain(secret);
  }
  await f.node.stop();
  expect(await command("refresh", "local")).toMatchObject({ state: "ok", effects: { run: "read" } });
  expect(await command("remove", "local")).toBeNull();
  expect(await command("list")).toEqual([]);
  const file = path.join(f.base, "definition.json");
  writeFileSync(file, JSON.stringify(payload));
  expect(await command("add", "--file", file)).toMatchObject({ id: "local", state: "ok" });
  expect(await command("presets")).toMatchObject([{ id: "github" }]);
}, 30_000);

test("handshakes during slow discovery and aborts a running CLI on disconnect", async () => {
  const f = await setup(undefined, 30, undefined, dir => {
    const fixture = `const fs = require("node:fs");
      if (process.argv.includes("--help")) {
        const timer = setInterval(() => { if (fs.existsSync("ready")) { clearInterval(timer); console.log("help"); } }, 20);
      } else { fs.writeFileSync("call.pid", String(process.pid)); setInterval(() => {}, 1000); }`;
    writeFileSync(path.join(dir, "adapters.json"), JSON.stringify([{ id: "slow", name: "Slow discovery", kind: "cli",
      config: { command: process.execPath, cwd: dir, args: ["-e", fixture, "--"] }, enabled: true, tools: [], effects: {} }]));
  });
  expect(f.hello.adapters).toMatchObject([{ state: "connecting" }]);
  f.send({ type: "adapters.manage", requestId: "first", action: "list" });
  writeFileSync(path.join(f.dir, "ready"), "");
  await until(() => f.messages.find(m => m.type === "adapters.state" && m.adapters[0]?.state === "ok"));
  f.send({ type: "tool.call", callId: "hang", adapterId: "slow", toolName: "run", args: { args: [] } });
  const pidFile = path.join(f.dir, "call.pid");
  const pid = await until(() => existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : undefined);
  f.reconnect({});
  await until(() => processExited(pid) || undefined);
  expect(f.messages.some(m => m.type === "tool.result" && m.callId === "hang")).toBe(false);
});
