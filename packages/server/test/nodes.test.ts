import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { connectPath, protocolVersion, type Hello, type HubMessage, type NodeMessage, type TaskEnd } from "@alter/node-protocol";
import { context } from "@alter/core";
import { say, toolCall } from "../../core/test/fixtures/gateway.ts";
import { cleanup, setup } from "./web-fixture.ts";

type Web = Awaited<ReturnType<typeof setup>>;
const device: Hello = { type: "hello", protocol: protocolVersion, nodeId: randomUUID(), name: "laptop",
  platform: "linux", nodeVersion: "24", roots: ["/work"], harnesses: [
    { id: "codex", available: true }, { id: "dsh", available: true, sessions: true, model: "test-model" },
  ], tasks: [] };

async function socket(web: Pick<Web, "base">, token: string) {
  const ws = new WebSocket(web.base.replace("http:", "ws:") + connectPath, { headers: { Authorization: "Bearer " + token } });
  const frames: HubMessage[] = [];
  ws.on("message", data => frames.push(JSON.parse(data.toString())));
  const closed = once(ws, "close");
  cleanup.push(async () => { ws.terminate(); await closed; });
  await once(ws, "open");
  async function take<K extends HubMessage["type"]>(type: K, requestId?: string) {
    const matches = (m: HubMessage) => m.type === type && (!requestId || (m.type === "approval.answer" && m.requestId === requestId));
    await expect.poll(() => frames.some(matches), { interval: 10 }).toBe(true);
    return frames.splice(frames.findIndex(matches), 1)[0] as Extract<HubMessage, { type: K }>;
  }
  const send = (m: NodeMessage) => ws.send(JSON.stringify(m));
  const hello = async (tasks: Hello["tasks"] = []) => { send({ ...device, tasks }); return take("welcome"); };
  return { send, take, hello, frames, closed, close: async () => { ws.close(); await closed; } };
}

async function fixture() {
  const modelInputs: string[] = [];
  const web = await setup(({ model, messages }, res) => {
    const last = messages.at(-1)!;
    modelInputs.push(JSON.stringify(messages));
    if (model === "offline/task") return say(res, '{"inScope":true,"reason":"用户已要求"}');
    const command = last.role === "user" && /\nCALL (\{.*\})$/.exec(last.content);
    if (command) {
      const { tool, args } = JSON.parse(command[1]!);
      return toolCall(res, tool, args);
    }
    if (last.role === "tool" && /^task-\d+/.test(last.content) && messages.some(m => m.content?.includes("silent node"))) {
      return toolCall(res, "stay_silent", { reason: "静默任务" });
    }
    say(res, "收到");
  });
  await web.login();
  const call = async (tool: string, args: object) => {
    await web.post("/api/messages", { text: "CALL " + JSON.stringify({ tool, args }) });
    await web.app.main.waitForIdle(context);
  };
  const response = await web.post("/api/nodes", { name: device.name });
  expect(response.status).toBe(201);
  const created: { id: string; token: string; pairCommand: string; runCommand: string; installCommand: string } = await response.json();
  const dispatch = (brief: string, node = device.name) => call("dispatch_task", {
    brief, permission: "restricted", context: "fresh", runner: { node, harness: "codex" }, cwd: "/work", thinking: "low",
  });
  return { ...web, created, call, dispatch, modelInputs };
}

it("authenticates the instance token separately from browser login, binds the device and revokes live connections", async () => {
  vi.stubEnv("ALTER_USER_ID", "roommate");
  cleanup.push(() => { vi.unstubAllEnvs(); });
  const web = await fixture();
  const { token, id, pairCommand } = web.created;
  expect(token).toMatch(/^roommate\.[\w-]+$/);
  expect(pairCommand).toContain(token);
  expect((await fetch(web.base + "/api/nodes")).status).toBe(401);
  expect(await (await web.read("/api/nodes")).json()).toEqual([{ id, name: device.name, online: false, platform: null,
    lastSeen: null, createdAt: expect.any(Number), roots: [], harnesses: [] }]);
  for (const invalid of [token.replace("roommate.", "admin."), "roommate.wrong", web.sessionCookie()]) {
    const bad = await socket(web, invalid);
    expect(await bad.take("rejected")).toBeTruthy();
    await bad.closed;
  }
  const node = await socket(web, token);
  expect(await node.hello()).toMatchObject({ protocol: 1, userId: "roommate", ackSeq: {} });
  expect(await (await web.read("/api/nodes")).json()).toMatchObject([{ online: true, roots: device.roots, harnesses: device.harnesses, lastSeen: expect.any(Number) }]);
  const impostor = await socket(web, token);
  impostor.send({ ...device, nodeId: randomUUID() });
  await impostor.take("rejected");
  await web.dispatch("吊销时仍在运行");
  const { taskId } = await node.take("task.start");
  const response = await fetch(web.base + "/api/nodes/" + id, { method: "DELETE", headers: { cookie: web.sessionCookie(), "Content-Type": "application/json" } });
  expect(response.status).toBe(204);
  await node.closed;
  expect((await web.state()).tasks.find(t => t.taskId === taskId)).toMatchObject({ status: "failed", reportSource: "failure" });
  expect(await (await web.read("/api/nodes")).json()).toEqual([]);
  await (await socket(web, token)).take("rejected");
});

it("persists the offline queue, drains in order and commits transcript events and reports exactly once across reconnects", async () => {
  const web = await fixture();
  await web.dispatch("first");
  await web.dispatch("second", web.created.id);
  const queued = (await web.state()).tasks;
  expect(queued.map(t => t.status)).toEqual(["queued", "queued"]);
  expect((await web.state()).timeline.find(i => i.tool === "dispatch_task" && i.taskId === queued[0]!.taskId))
    .toMatchObject({ runner: { node: web.created.id, harness: "codex" }, status: "queued" });
  const taskId = queued[0]!.taskId;
  await web.call("task_status", { taskId });
  expect(web.modelInputs.some(m => m.includes("已排队，电脑上线后开始"))).toBe(true);
  await web.close();
  let restarted = await web.reopen();
  await restarted.login();
  const node = await socket(restarted, web.created.token);
  await node.hello();
  expect(await node.take("task.start")).toEqual({ type: "task.start", taskId, harness: "codex", brief: "first",
    permission: "restricted", cwd: "/work", thinking: "low" });
  expect(await node.take("task.start")).toMatchObject({ brief: "second", taskId: queued[1]!.taskId });
  const events = [
    { kind: "thinking", text: "思考" }, { kind: "text", text: "正文" },
    { kind: "tool_call", tool: "Read", args: { path: "file" } }, { kind: "tool_result", tool: "Read", text: "ok" },
    { kind: "status", text: "working" },
  ] as const;
  for (const [i, event] of events.entries()) node.send({ type: "task.event", at: 42, seq: i + 1, taskId, ...event });
  for (let seq = 1; seq <= 5; seq++) expect(await node.take("ack")).toMatchObject({ taskId, seq });
  await node.close();
  await restarted.close();
  restarted = await web.reopen();
  await restarted.login();
  const again = await socket(restarted, web.created.token);
  expect(await again.hello(queued.map(t => ({ taskId: t.taskId, state: "running", lastSeq: t.taskId === taskId ? 5 : 0 })))).toMatchObject({ ackSeq: { [taskId]: 5 } });
  again.send({ type: "task.event", at: 42, seq: 1, taskId, ...events[0] });
  expect(await again.take("ack")).toMatchObject({ seq: 5 });
  const items = (await (await restarted.read(`/api/tasks/${taskId}/transcript`)).json()).items;
  expect(items).toEqual([{ kind: "user", text: "first", at: expect.any(Number) }, { kind: "thinking", text: "思考", at: 42 },
    { kind: "assistant", text: "正文", at: 42 }, { kind: "tool_call", tool: "Read", arguments: { path: "file" }, at: 42 },
    { kind: "tool_result", tool: "Read", text: "ok", isError: false, at: 42 }, { kind: "status", text: "working", at: 42 }]);
  expect(again.frames.some(m => m.type === "task.start")).toBe(false);
});

it("steers and interrupts a live task, resumes its native session, and wakes main for each report source", async () => {
  const web = await fixture();
  const node = await socket(web, web.created.token);
  await node.hello();
  await web.dispatch("implement");
  let { taskId } = await node.take("task.start");
  expect(web.modelInputs.some(m => m.includes("我的电脑") && m.includes("/work"))).toBe(true);
  await web.call("task_message", { taskId, message: "再检查一次" });
  expect(await node.take("task.message")).toMatchObject({ taskId, text: "再检查一次" });
  for (const source of ["finish", "last_message", "failure"] as const) {
    if (source === "failure") {
      await web.call("task_stop", { taskId });
      expect(await node.take("task.stop")).toMatchObject({ taskId });
    }
    const end: TaskEnd = { type: "task.end", taskId, at: Date.now(), seq: 1, reportSource: source,
      status: source === "failure" ? "interrupted" : "completed", report: { summary: "report-" + source, refs: [{ kind: "file", ref: "a" }] },
      nativeSessionId: "session-" + source };
    node.send(end);
    await node.take("ack");
    node.send(end);
    await node.take("ack");
    await web.app.main.waitForIdle(context);
    const state = await web.state();
    expect(state.tasks.find(t => t.taskId === taskId)).toMatchObject({ status: end.status, runner: { node: web.created.id, harness: "codex" },
      reportSource: source, nativeSessionId: end.nativeSessionId });
    expect(state.ledger.filter(e => e.taskId === taskId)).toEqual([{ taskId, at: expect.any(Number), ...end.report }]);
    expect(state.timeline.filter(i => i.kind === "report" && i.taskId === taskId)).toHaveLength(1);
    expect(web.modelInputs.some(m => m.includes("系统消息 · 任务报告") && m.includes("report-" + source))).toBe(true);
    if (source !== "failure") {
      await web.call("dispatch_task", { brief: "continue", continue_from: taskId });
      const next = await node.take("task.start");
      expect(next).toMatchObject({ resume: end.nativeSessionId, permission: "restricted", cwd: "/work", harness: "codex" });
      taskId = next.taskId;
    }
  }
});

it("uses the existing approval model, four decisions, once window and durable replies after reconnect", async () => {
  const web = await fixture();
  let node = await socket(web, web.created.token);
  await node.hello();
  await web.dispatch("approve actions");
  const { taskId } = await node.take("task.start");
  let seq = 0;
  const ask = async (tool: string, effect: "irreversible" | "write" = "irreversible") => {
    const msg = { type: "approval.request" as const, requestId: "r" + ++seq, seq, taskId, at: Date.now(), tool, effect, args: { file: "a" }, summary: "使用 " + tool };
    node.send(msg);
    expect(await node.take("ack")).toMatchObject({ seq });
    return msg;
  };
  const decide = async (decision: string) => {
    await expect.poll(async () => (await web.state()).pending.length).toBe(1);
    const [req] = (await web.state()).pending;
    expect(req).toMatchObject({ taskId, capability: "node:codex" });
    expect((await web.post("/api/permissions/" + req!.id, { decision, note: "用户决定" })).status).toBe(204);
  };
  await ask("Edit", "write");
  expect(await node.take("approval.answer")).toMatchObject({ decision: "once" });
  const first = await ask("Delete");
  await expect.poll(async () => (await web.state()).pending.length).toBe(1);
  const original = (await web.state()).pending[0]!.id;
  await node.close();
  node = await socket(web, web.created.token);
  await node.hello([{ taskId, state: "running", lastSeq: seq }]);
  node.send(first);
  await node.take("ack");
  expect((await web.state()).pending.map(r => r.id)).toEqual([original]);
  await node.close();
  await decide("deny");
  node = await socket(web, web.created.token);
  await node.hello([{ taskId, state: "running", lastSeq: seq }]);
  await node.take("approval.answer", "r1");
  expect(await node.take("approval.answer", first.requestId)).toMatchObject({ requestId: first.requestId, decision: "deny", note: "用户决定" });
  await ask("Move");
  await decide("once");
  expect(await node.take("approval.answer")).toMatchObject({ decision: "once" });
  await ask("Move");
  expect(await node.take("approval.answer")).toMatchObject({ decision: "once" });
  await ask("Rename");
  await decide("capability");
  expect(await node.take("approval.answer")).toMatchObject({ decision: "capability" });
  await ask("Another");
  expect(await node.take("approval.answer")).toMatchObject({ decision: "once" });
  await web.dispatch("another task");
  const second = (await node.take("task.start")).taskId;
  node.send({ ...first, taskId: second, seq: 1 });
  await node.take("ack");
  await expect.poll(async () => (await web.state()).pending.length).toBe(1);
  const card = (await web.state()).pending[0]!;
  expect((await web.post("/api/permissions/" + card.id, { decision: "always" })).status).toBe(204);
  expect(await node.take("approval.answer")).toMatchObject({ decision: "always", taskId: second });
  expect(await (await web.read("/api/settings/always-allowed")).json()).toEqual({ capabilities: ["node:codex"] });
  await web.dispatch("subsequent task");
  const third = (await node.take("task.start")).taskId;
  node.send({ ...first, taskId: third, seq: 1 });
  await node.take("ack");
  expect(await node.take("approval.answer")).toMatchObject({ decision: "once", taskId: third });
  expect((await web.state()).pending).toEqual([]);
});

it("keeps each task bound to its pairing and recovers a sequence gap from the last committed cursor", async () => {
  const web = await fixture();
  const node = await socket(web, web.created.token);
  await node.hello();
  await web.dispatch("keep my events");
  const { taskId } = await node.take("task.start");
  const other = await (await web.post("/api/nodes", { name: "other" })).json();
  const foreign = await socket(web, other.token);
  foreign.send({ ...device, nodeId: randomUUID(), tasks: [{ taskId, lastSeq: 10, state: "ended" }] });
  expect((await foreign.take("welcome")).ackSeq).toEqual({});
  const event = { type: "task.event" as const, taskId, seq: 1, at: 1, kind: "text" as const, text: "owner only" };
  foreign.send(event);
  await foreign.closed;
  node.send({ ...event, seq: 2 });
  await node.closed;
  const again = await socket(web, web.created.token);
  expect(await again.hello([{ taskId, state: "running", lastSeq: 2 }])).toMatchObject({ ackSeq: { [taskId]: 0 } });
  again.send(event);
  again.send({ ...event, seq: 2, text: "second" });
  expect(await again.take("ack")).toMatchObject({ seq: 1 });
  expect(await again.take("ack")).toMatchObject({ seq: 2 });
  const transcript = await (await web.read(`/api/tasks/${taskId}/transcript`)).json();
  expect(transcript.items.map((i: { text: string }) => i.text)).toEqual(["keep my events", "owner only", "second"]);
});

it("cancels a queued task and delivers offline steering only to the surviving task", async () => {
  const web = await fixture();
  await web.dispatch("cancel me");
  await web.dispatch("keep me");
  const [first, second] = (await web.state()).tasks;
  await web.call("task_stop", { taskId: first!.taskId });
  await web.call("task_message", { taskId: second!.taskId, message: "offline note" });
  expect((await web.state()).tasks.map(t => t.status)).toEqual(["interrupted", "queued"]);
  const node = await socket(web, web.created.token);
  await node.hello();
  expect(await node.take("task.start")).toMatchObject({ taskId: second!.taskId });
  expect(await node.take("task.message")).toMatchObject({ taskId: second!.taskId, text: "offline note" });
  expect(node.frames.filter(m => m.type === "task.start")).toEqual([]);
});

it("pings after 20 seconds, renews on pong, and disconnects a silent peer after 60 seconds", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  cleanup.push(() => { vi.useRealTimers(); });
  const web = await fixture();
  const node = await socket(web, web.created.token);
  await node.hello();
  const seen = (await web.app.nodes.all())[0]!.lastSeen!;
  await vi.advanceTimersByTimeAsync(20_000);
  const ping = await node.take("ping");
  node.send({ type: "pong", at: ping.at });
  await expect.poll(async () => (await web.app.nodes.all())[0]!.lastSeen).toBeGreaterThan(seen);
  await vi.advanceTimersByTimeAsync(45_000);
  expect((await web.app.nodes.all())[0]?.online).toBe(true);
  await vi.advanceTimersByTimeAsync(15_000);
  await node.closed;
  expect((await web.app.nodes.all())[0]?.online).toBe(false);
});

it("matches concurrent HTTP and tool session lists to their replies without task acknowledgments", async () => {
  const web = await fixture();
  const node = await socket(web, web.created.token);
  await node.hello();
  const path = `/api/nodes/${web.created.id}/sessions?harness=dsh`;
  const cwd = "/work/目录 & 项目";
  const http = web.read(path + "&cwd=" + encodeURIComponent(cwd));
  const first = await node.take("sessions.list");
  expect(first).toMatchObject({ harness: "dsh", cwd });
  const tool = web.call("node_sessions", { node: device.name, harness: "dsh" });
  const second = await node.take("sessions.list");
  expect(second.requestId).not.toBe(first.requestId);
  expect(second).not.toHaveProperty("cwd");
  const sessions = [{ title: "迁移工作", sessionId: "native-1", cwd, updatedAt: 12345 }];
  node.send({ type: "sessions.result", requestId: second.requestId, harness: "dsh", sessions });
  await tool;
  const toolOutputs = web.modelInputs.flatMap(input => JSON.parse(input)).filter(m => m.role === "tool").map(m => m.content);
  expect(toolOutputs).toContain(JSON.stringify(sessions));
  node.send({ type: "sessions.result", requestId: first.requestId, harness: "dsh", sessions: [] });
  const response = await http;
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([]);
  const listed = web.read(path);
  const { requestId } = await node.take("sessions.list");
  node.send({ type: "sessions.result", requestId, harness: "dsh", sessions });
  expect(await (await listed).json()).toEqual(sessions);
  expect(node.frames.filter(m => m.type === "ack")).toEqual([]);
  expect((await web.state()).pending).toEqual([]);
});

it("reports invalid, offline and unsupported session queries directly, and propagates node failures", async () => {
  const web = await fixture();
  const path = `/api/nodes/${web.created.id}/sessions`;
  expect((await fetch(web.base + path + "?harness=dsh")).status).toBe(401);
  for (const query of ["", "?harness=typo"]) expect((await web.read(path + query)).status).toBe(400);
  expect((await web.read("/api/nodes/missing/sessions?harness=dsh")).status).toBe(404);
  const offline = await web.read(path + "?harness=dsh");
  expect(offline.status).toBe(503);
  expect(await offline.json()).toEqual({ error: "电脑不在线" });
  const node = await socket(web, web.created.token);
  await node.hello();
  await web.call("node_sessions", { node: web.created.id, harness: "codex" });
  expect(web.modelInputs.some(m => m.includes("codex 不支持列出已有会话"))).toBe(true);
  expect((await web.read(path + "?harness=codex")).status).toBe(409);
  expect(node.frames).toEqual([]);
  const failed = web.read(path + "?harness=dsh");
  const { requestId } = await node.take("sessions.list");
  node.send({ type: "sessions.result", requestId, harness: "dsh", sessions: [], error: "代理查询失败" });
  const response = await failed;
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "代理查询失败" });
});

it("times out a session query after 25 seconds and ignores its late reply", async () => {
  const web = await fixture();
  const node = await socket(web, web.created.token);
  await node.hello();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const pending = web.app.nodes.sessions(web.created.id, "dsh");
    const expired = expect(pending).rejects.toMatchObject({ status: 504, message: "查询已有会话超时" });
    const { requestId } = await node.take("sessions.list");
    await vi.advanceTimersByTimeAsync(25_000);
    await expired;
    node.send({ type: "sessions.result", requestId, harness: "dsh", sessions: [] });
  } finally { vi.useRealTimers(); }
  const retry = web.app.nodes.sessions(web.created.id, "dsh");
  const { requestId } = await node.take("sessions.list");
  node.send({ type: "sessions.result", requestId, harness: "dsh", sessions: [] });
  expect(await retry).toEqual([]);
  expect(node.frames).toEqual([]);
});

it("queues an explicit native session without cwd and continues with the ID reported at task end", async () => {
  const web = await fixture();
  await web.call("dispatch_task", { brief: "接着做", permission: "restricted", runner: { node: device.name, harness: "dsh", session: "from-tui" } });
  expect((await web.state()).tasks[0]).toMatchObject({ status: "queued", runner: { node: web.created.id, harness: "dsh", session: "from-tui" } });
  const node = await socket(web, web.created.token);
  await node.hello();
  const start = await node.take("task.start");
  expect(start).toMatchObject({ harness: "dsh", resume: "from-tui" });
  expect(start).not.toHaveProperty("cwd");
  node.send({ type: "task.end", taskId: start.taskId, seq: 1, at: Date.now(), status: "completed",
    reportSource: "finish", report: { summary: "完成", refs: [] }, nativeSessionId: "after-task" });
  await node.take("ack");
  await web.app.main.waitForIdle(context);
  await web.call("dispatch_task", { brief: "再检查", continue_from: start.taskId });
  expect(await node.take("task.start")).toMatchObject({ harness: "dsh", resume: "after-task" });
  await web.call("dispatch_task", { brief: "新任务", permission: "restricted", runner: { node: device.name, harness: "dsh" } });
  expect(await node.take("task.start")).not.toHaveProperty("resume");
});

it("retains the originating silent turn when a queued task eventually reports a failure", async () => {
  const web = await fixture();
  await web.dispatch("silent node");
  expect((await web.state()).tasks[0]).toMatchObject({ status: "queued", originSilent: true });
  const node = await socket(web, web.created.token);
  await node.hello();
  const { taskId } = await node.take("task.start");
  node.send({ type: "task.end", seq: 1, at: Date.now(), taskId, status: "failed", reportSource: "failure",
    report: { summary: "代理进程退出", refs: [] } });
  await node.take("ack");
  await web.app.main.waitForIdle(context);
  const state = await web.state();
  expect(state.tasks[0]).toMatchObject({ taskId, status: "failed", failure: "代理进程退出", reportSource: "failure" });
  expect(web.modelInputs.some(m => m.includes("这是静默模式下派遣的任务") && m.includes("代理进程退出"))).toBe(true);
});
