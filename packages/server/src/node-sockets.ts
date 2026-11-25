import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { connectPath, protocolVersion, type HubMessage, type NodeMessage } from "@alter/node-protocol";
import { PairingError, validHarness, type AlterApp } from "@alter/core";

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === "string";
const id = (v: unknown): v is string => string(v) && !!v && v.length <= 256;
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const oneOf = (v: unknown, ...choices: string[]) => string(v) && choices.includes(v);

function valid(m: unknown): m is NodeMessage {
  if (!record(m)) return false;
  if (m.type === "hello") return m.protocol === protocolVersion && id(m.nodeId) && id(m.name) &&
    oneOf(m.platform, "darwin", "linux", "win32") && string(m.nodeVersion) &&
    Array.isArray(m.roots) && m.roots.every(string) && Array.isArray(m.harnesses) && m.harnesses.every(h =>
      record(h) && validHarness.check(h.id) && typeof h.available === "boolean" &&
      (h.version === undefined || string(h.version)) && (h.detail === undefined || string(h.detail)) &&
      (h.sessions === undefined || typeof h.sessions === "boolean") && (h.model === undefined || string(h.model))) &&
    Array.isArray(m.tasks) && m.tasks.every(t => record(t) && id(t.taskId) && integer(t.lastSeq) && oneOf(t.state, "running", "ended"));
  if (m.type === "sessions.result") return id(m.requestId) && validHarness.check(m.harness) &&
    (m.error === undefined || string(m.error)) && Array.isArray(m.sessions) && m.sessions.every(s =>
      record(s) && id(s.sessionId) && string(s.cwd) && (s.title === undefined || string(s.title)) &&
      (s.updatedAt === undefined || integer(s.updatedAt)));
  if (!integer(m.at)) return false;
  if (m.type === "pong") return true;
  if (!id(m.taskId) || !integer(m.seq) || m.seq < 1) return false;
  if (m.type === "task.event") return oneOf(m.kind, "text", "thinking", "tool_call", "tool_result", "status") &&
    (m.text === undefined || string(m.text)) && (m.tool === undefined || string(m.tool)) &&
    (m.isError === undefined || typeof m.isError === "boolean");
  if (m.type === "approval.request") return id(m.requestId) && id(m.tool) && "args" in m &&
    oneOf(m.effect, "read", "write", "irreversible") && string(m.summary);
  return m.type === "task.end" && oneOf(m.status, "completed", "failed", "interrupted") &&
    oneOf(m.reportSource, "finish", "last_message", "failure") && (m.nativeSessionId === undefined || string(m.nativeSessionId)) &&
    record(m.report) && string(m.report.summary) && Array.isArray(m.report.refs) &&
    m.report.refs.every(ref => record(ref) && string(ref.kind) && string(ref.ref));
}

export function attachNodeSockets(server: Server, nodes: AlterApp["nodes"]) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  const online = new Set<WebSocket>();
  const draining = new Set<Promise<void>>();
  function connected(ws: WebSocket, req: IncomingMessage) {
    const idle = setTimeout(() => ws.terminate(), 60_000).unref();
    const peer = {
      open: () => ws.readyState === WebSocket.OPEN,
      send: (message: HubMessage) => { if (peer.open()) ws.send(JSON.stringify(message)); },
      close: () => ws.close(1008),
    };
    function reject(reason: string) {
      if (peer.open()) { peer.send({ type: "rejected", reason }); peer.close(); }
    }
    let node: string | undefined;
    let ready = false;
    const token = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? "")?.[1];
    let pending = Promise.resolve().then(async () => {
      node = token && await nodes.authenticate(token);
      if (!node) reject("Invalid node token");
    }).catch(() => reject("Pairing unavailable"));
    let queued = 0;
    ws.on("message", (raw, binary) => {
      idle.refresh();
      if (binary) { ws.close(1003); return; }
      if (++queued === 32) ws.pause();
      pending = pending.then(async () => {
        if (!node || !peer.open()) return;
        const msg: unknown = JSON.parse(raw.toString());
        if (!valid(msg)) {
          if (record(msg) && msg.type === "hello" && msg.protocol !== protocolVersion) reject("Unsupported protocol");
          else ws.close(1002);
          return;
        }
        if (msg.type === "hello" && !ready) {
          await nodes.hello(node, peer, msg);
          ready = true;
          if (peer.open()) online.add(ws);
        } else if (ready && msg.type !== "hello") await nodes.receive(node, peer, msg);
        else throw new Error("Expected hello");
      }).catch(error => {
        if (error instanceof PairingError) reject(error.message);
        else ws.close(1002);
      }).finally(() => { if (--queued === 8 && peer.open()) ws.resume(); });
    });
    ws.on("error", () => ws.terminate());
    const closed = new Promise<void>(resolve => ws.once("close", () => {
      clearTimeout(idle);
      online.delete(ws);
      void pending.then(() => node ? nodes.disconnect(node, peer) : undefined)
        .catch(err => console.error("Node disconnect failed", err)).finally(resolve);
    }));
    draining.add(closed);
    void closed.then(() => draining.delete(closed));
  }
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (req.url?.split("?")[0] !== connectPath) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => connected(ws, req));
  };
  server.on("upgrade", upgrade);
  const timer = setInterval(() => {
    for (const ws of online) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", at: Date.now() } satisfies HubMessage));
    }
  }, 20_000).unref();
  return async () => {
    clearInterval(timer);
    server.off("upgrade", upgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await Promise.all(draining);
  };
}
