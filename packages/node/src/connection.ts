import path from "node:path";
import WebSocket from "ws";
import { connectPath, parseNodeToken, protocolVersion, type HubMessage, type NodeMessage } from "@alter/node-protocol";
import { atomicWrite, loadConfig, lock, type Platform } from "./config.ts";
import type { Detected } from "./spawn.ts";
import { Tasks } from "./tasks.ts";

export function runNode(dir: string, harnesses: Detected[], options: { retryMs?: number; idleMs?: number; timeoutMs?: number } = {}) {
  const release = lock(dir, "run");
  let socket: WebSocket | undefined, online = false, closing = false, retry: NodeJS.Timeout | undefined, idle: NodeJS.Timeout | undefined;
  const initial = options.retryMs ?? 1000;
  let delay = initial;
  const done = Promise.withResolvers<void>();
  const status = (state: string) => atomicWrite(path.join(dir, "status.json"), JSON.stringify({ state, pid: process.pid, at: Date.now() }));
  const send = (m: NodeMessage) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m)); };
  let tasks: Tasks;
  async function stop(error?: Error) {
    if (closing) return done.promise;
    closing = true;
    clearTimeout(retry); clearTimeout(idle);
    try {
      await tasks.shutdown();
      status(error ? "配对被拒绝" : "已停止");
    } catch (err) {
      done.reject(err);
    } finally {
      socket?.terminate(); online = false; release();
    }
    if (error) done.reject(error); else done.resolve();
    return done.promise;
  }
  function connect() {
    const config = loadConfig(dir);
    const url = new URL(connectPath, config.server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    status("正在连接");
    const ws = new WebSocket(url, { headers: { Authorization: "Bearer " + config.token }, handshakeTimeout: 15000 });
    socket = ws;
    function heartbeat() {
      clearTimeout(idle);
      idle = setTimeout(() => ws.terminate(), options.idleMs ?? 60000);
    }
    ws.on("open", () => {
      heartbeat();
      send({ type: "hello", protocol: protocolVersion, nodeId: config.nodeId, name: config.name, platform: process.platform as Platform,
        nodeVersion: process.version, harnesses: harnesses.map(({ executable: _, ...h }) => h), roots: config.roots, tasks: tasks.box.tasks() });
    });
    ws.on("message", raw => {
      if (closing) return;
      let m: HubMessage;
      try { m = JSON.parse(raw.toString()); } catch { ws.close(1002); return; }
      if (!m || typeof m !== "object") { ws.close(1002); return; }
      heartbeat();
      if (m.type === "rejected") { void stop(new Error("网关拒绝了节点配对")).catch(() => {}); return; }
      if (m.type === "ping") { send({ type: "pong", at: m.at }); return; }
      if (m.type === "welcome" && !online) {
        if (m.protocol !== protocolVersion || m.userId !== parseNodeToken(config.token)?.userId ||
          !m.ackSeq || typeof m.ackSeq !== "object" || Array.isArray(m.ackSeq)) {
          void stop(new Error("welcome 的协议、用户或确认序号无效")).catch(() => {}); return;
        }
        online = true; delay = initial; status("在线"); tasks.replay(m.ackSeq); return;
      }
      if (!online) { ws.close(1002); return; }
      switch (m.type) {
        case "task.start": tasks.start(m); break;
        case "task.stop": void tasks.active.get(m.taskId)?.stop({ status: "interrupted", reason: m.reason || "用户停止任务" }); break;
        case "task.message": if (typeof m.text === "string") tasks.active.get(m.taskId)?.queue.push(m.text); break;
        case "approval.answer": tasks.answer(m); break;
        case "ack": tasks.box.ack(m.taskId, m.seq); break;
      }
    });
    ws.on("error", () => {}); // close drives reconnect; never log request headers.
    ws.on("unexpected-response", (_req, res) => {
      res.resume(); ws.terminate();
      if (res.statusCode === 401 || res.statusCode === 403) void stop(new Error("节点身份验证失败")).catch(() => {});
    });
    ws.on("close", () => {
      online = false; clearTimeout(idle);
      if (closing) return;
      status("等待重连");
      retry = setTimeout(() => {
        try { connect(); } catch { void stop(new Error("无法根据本地配置重连")).catch(() => {}); }
      }, delay);
      delay = Math.min(delay * 2, 60000);
    });
  }
  try {
    tasks = new Tasks(dir, harnesses, entry => { if (online) send(entry); }, options.timeoutMs);
    connect();
  } catch (err) { release(); throw err; }
  return { stop: () => stop(), done: done.promise };
}
