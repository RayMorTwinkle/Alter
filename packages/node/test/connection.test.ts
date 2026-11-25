import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, expect, test } from "vitest";
import type { ApprovalRequest, HarnessId, Hello, HubMessage, NodeMessage, TaskEnd, TaskStart } from "@alter/node-protocol";
import { runNode } from "../src/connection.ts";
import { configDir, pair } from "../src/config.ts";
import { workspace, until } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function setup(timeoutMs?: number, retryMs = 30) {
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
  const node = runNode(f.dir, f.harnesses, { retryMs, timeoutMs });
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

test.each(["codex", "claude-code"] as const)("stop kills the %s process tree before the report", async harness => {
  const f = await setup();
  f.start("long", "hold", harness);
  await until(() => f.messages.find(m => m.type === "task.event" && m.text === "等待"));
  const pids: number[] = JSON.parse(readFileSync(path.join(f.root, "pids.json"), "utf8"));
  f.send({ type: "task.stop", taskId: "long", reason: "手动停止" });
  expect(await f.end("long")).toMatchObject({ status: "interrupted", reportSource: "failure", report: { summary: "手动停止\n等待" } });
  if (process.platform !== "win32") expect(readFileSync(path.join(f.root, "trace.jsonl"), "utf8"))
    .toContain(harness === "codex" ? '"method":"turn/interrupt"' : '"subtype":"interrupt"');
  await until(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }) || undefined);
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
  await until(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }) || undefined);
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

test.skipIf(process.platform === "win32")("CLI run advertises detected shims, reports live status and drains on SIGTERM", async () => {
  const f = workspace(), cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const env = { ...process.env, HOME: f.base, PATH: f.bin + path.delimiter + path.dirname(process.execPath) };
  const hub = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(hub, "listening");
  const dir = configDir(process.platform, f.base);
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
      { available: true, version: "1.2.3" }, { available: false, version: "1.2.3" }] });
    expect(JSON.parse(execFileSync(process.execPath, [cli, "status"], { env, encoding: "utf8" })).state).toBe("在线");
    child.kill("SIGTERM");
    expect((await exited)[0]).toBe(0);
    expect(readFileSync(path.join(dir, "outbox/cli.jsonl"), "utf8")).toContain('"status":"interrupted"');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; }
    for (const s of hub.clients) s.terminate();
    await new Promise<void>(resolve => hub.close(() => resolve())); rmSync(f.base, { recursive: true, force: true });
  }
});
