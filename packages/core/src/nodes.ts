import type { JsonValue } from "@earendil-works/chord/json";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { parseNodeToken, protocolVersion, type ApprovalRequest, type HarnessId, type Hello, type HubMessage, type NativeSession, type NodeMessage, type SessionsResult } from "@alter/node-protocol";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { harnessSchema, NodeRuns } from "./node-state.ts";
import { context, conversationDoc, defineTask, defineTool, reply, type Conversation, type JsonObject, type Tx } from "./runtime.ts";
import { Tasks, type TaskRecord } from "./state.ts";
import { endNodeTask } from "./tasks.ts";

type NodeRecord = Pick<Hello, "name" | "harnesses" | "roots"> & {
  id: string; hash: string; deviceId?: string; platform: Hello["platform"] | null; createdAt: number; lastSeen: number | null;
};
const Nodes = conversationDoc<{ records: NodeRecord[] }>("paired-nodes", () => ({ records: [] }));
const hash = (secret: string) => createHash("sha256").update(secret).digest();
export class PairingError extends Error {}
export class NodeSessionsError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export type NodePeer = { send(message: HubMessage): void; close(): void; open(): boolean };
type RequestApproval = (tx: Tx, task: TaskRecord, message: ApprovalRequest) => Promise<void>;

export class NodeHub {
  readonly userId = process.env.ALTER_USER_ID?.trim() || "admin";
  private peers = new Map<string, NodePeer>();
  private pendingSessions = new Map<string, { peer: NodePeer; harness: HarnessId; resolve: (result: SessionsResult) => void }>();
  private sentStops = new WeakMap<NodePeer, Set<string>>();
  private tail = Promise.resolve();
  private main: () => Conversation;
  private now: () => number;
  private requestApproval: RequestApproval;
  constructor(main: () => Conversation, now: () => number, requestApproval: RequestApproval) {
    this.main = main;
    this.now = now;
    this.requestApproval = requestApproval;
  }

  // Order socket replacement, queue draining and incoming frames on one line for this instance.
  private serial<T>(work: () => Promise<T>) {
    const next = this.tail.then(work);
    this.tail = next.then(() => {}, () => {});
    return next;
  }

  async list(tx: Tx) {
    const { records } = await tx.doc(Nodes, this.main().id);
    return records.map(({ hash, deviceId, ...node }) => ({ ...node, roots: [...node.roots], harnesses: node.harnesses.map(h => ({ ...h })), online: !!this.peers.get(node.id)?.open() }));
  }
  all() { return this.main().commit(tx => this.list(tx), context); }
  async sessions(target: string, harness: HarnessId, cwd?: string): Promise<NativeSession[]> {
    const node = (await this.all()).find(n => n.id === target || n.name === target);
    if (!node) throw new NodeSessionsError(404, "Unknown node: " + target);
    const peer = this.peers.get(node.id);
    if (!peer?.open()) throw new NodeSessionsError(503, "电脑不在线");
    if (!node.harnesses.some(h => h.id === harness && h.available && h.sessions))
      throw new NodeSessionsError(409, harness + " 不支持列出已有会话");

    const requestId = randomUUID();
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await new Promise<SessionsResult>((resolve, reject) => {
        timer = setTimeout(() => reject(new NodeSessionsError(504, "查询已有会话超时")), 25_000);
        this.pendingSessions.set(requestId, { peer, harness, resolve });
        peer.send({ type: "sessions.list", requestId, harness, ...(cwd && { cwd }) });
      });
      if (result.error !== undefined) throw new NodeSessionsError(502, result.error);
      return result.sessions;
    } finally {
      clearTimeout(timer);
      this.pendingSessions.delete(requestId);
    }
  }
  async prompt(tx: Tx) {
    const nodes = await this.list(tx);
    if (!nodes.length) return "";
    const inventory = nodes.map(n => ({ name: n.name, online: n.online, harnesses: n.harnesses.filter(h => h.available).map(h => ({ id: h.id, sessions: !!h.sessions })), roots: n.roots }));
    return "\n我的电脑（节点资料）" + JSON.stringify(inventory) + "。用户提到自己的电脑或要写代码、改文件时，可以用 dispatch_task 的 runner 派给节点上的代理。节点离线时任务会排队；结束后报告自动送回，不用轮询 task_status。" +
      "sessions 表示支持已有会话，dsh 是 DeepSeek Harness。用户要求接着在 opencode、dsh 等代理里的对话做时，先用 node_sessions 找到对应会话，再将 sessionId 填入 dispatch_task 的 runner.session。新任务默认开启新会话。";
  }

  create(name: string) {
    return this.main().commit(async tx => {
      const { records } = await tx.doc(Nodes, this.main().id);
      if (records.some(n => n.name === name || n.id === name)) return;
      const secret = randomBytes(32).toString("base64url");
      const id = randomUUID();
      records.push({ id, name, hash: hash(secret).toString("hex"), harnesses: [], roots: [], platform: null, createdAt: this.now(), lastSeen: null });
      return { id, token: this.userId + "." + secret };
    }, context);
  }
  async authenticate(token: string) {
    const parsed = parseNodeToken(token);
    if (parsed?.userId !== this.userId) return;
    const digest = hash(parsed.secret);
    return this.main().commit(async tx => (await tx.doc(Nodes, this.main().id)).records
      .find(n => timingSafeEqual(Buffer.from(n.hash, "hex"), digest))?.id, context);
  }
  revoke(id: string) {
    return this.serial(async () => {
      const main = this.main();
      const removed = await main.commit(async tx => {
        const { records } = await tx.doc(Nodes, main.id);
        const index = records.findIndex(n => n.id === id);
        if (index < 0) return false;
        records.splice(index, 1);
        for (const [taskId, task] of Object.entries((await tx.doc(Tasks, main.id)).byId)) {
          if (task.runner?.node === id && (task.status === "running" || task.status === "queued")) {
            await endNodeTask(tx, main, taskId, task, this.now(), "failed", { summary: "节点已吊销", refs: [] }, "failure");
          }
        }
        return true;
      }, context);
      this.peers.get(id)?.close();
      this.peers.delete(id);
      return removed;
    });
  }
  disconnect(id: string, peer: NodePeer) {
    return this.serial(async () => {
      if (this.peers.get(id) === peer) this.peers.delete(id);
    });
  }
  private async touch(tx: Tx, id: string) {
    const node = (await tx.doc(Nodes, this.main().id)).records.find(n => n.id === id);
    if (node) node.lastSeen = this.now();
  }
  send(id: string, message: HubMessage) {
    const peer = this.peers.get(id);
    if (peer?.open()) peer.send(message);
  }

  hello(id: string, peer: NodePeer, hello: Hello) {
    return this.serial(async () => {
      const main = this.main();
      const remote = new Map(hello.tasks.map(t => [t.taskId, t]));
      const ended = new Set(hello.tasks.filter(t => t.state === "ended").map(t => t.taskId));
      const replies = await main.commit(async tx => {
        const node = (await tx.doc(Nodes, main.id)).records.find(n => n.id === id);
        if (!node || (node.deviceId && node.deviceId !== hello.nodeId)) throw new PairingError("Invalid pairing");
        Object.assign(node, { deviceId: hello.nodeId, platform: hello.platform, harnesses: hello.harnesses, roots: hello.roots, lastSeen: this.now() });
        const ackSeq: Record<string, number> = {};
        const answers: HubMessage[] = [];
        for (const [taskId, task] of Object.entries((await tx.doc(Tasks, main.id)).byId)) {
          if (task.runner?.node !== id) continue;
          const run = (await tx.doc(NodeRuns, task.conversationId)).byId[taskId]!;
          const announced = remote.get(taskId);
          if (announced) {
            if (announced.lastSeq < run.ackSeq) throw new Error("Node sequence is behind the acknowledged cursor");
            if (task.status === "queued") task.status = "running";
            ackSeq[taskId] = run.ackSeq;
            if (task.status === "running" && announced.state === "running") for (const { answer } of Object.values(run.approvals)) {
              if (answer) answers.push({ ...answer });
            }
          } else if (task.status === "running") {
            if (run.ackSeq === 0 && !run.stopping) {
              task.status = "queued";
              for (const m of run.messages) delete m.sent;
            } else await endNodeTask(tx, main, taskId, task, this.now(), "interrupted", { summary: "重连后节点已无此任务", refs: [] }, "failure");
          }
        }
        return [{ type: "welcome", userId: this.userId, protocol: protocolVersion, ackSeq }, ...answers] satisfies HubMessage[];
      }, context);
      if (!peer.open()) return;
      this.peers.get(id)?.close();
      this.peers.set(id, peer);
      this.sentStops.set(peer, new Set());
      for (const msg of replies) peer.send(msg);
      await this.drain(id, ended);
    });
  }

  flush(id: string) { return this.serial(() => this.drain(id)); }
  private async drain(id: string, ended?: Set<string>) {
    const peer = this.peers.get(id);
    if (!peer?.open()) return;
    const main = this.main();
    const messages = await main.commit(async tx => {
      const out: { message: HubMessage; steeringId?: string }[] = [];
      const tasks = Object.entries((await tx.doc(Tasks, main.id)).byId).sort((a, b) => a[1].createdAt - b[1].createdAt);
      for (const [taskId, task] of tasks) {
        if (ended?.has(taskId) || task.runner?.node !== id || (task.status !== "queued" && task.status !== "running")) continue;
        const run = (await tx.doc(NodeRuns, task.conversationId)).byId[taskId]!;
        if (task.status === "queued") {
          out.push({ message: { ...run.start } });
          task.status = "running";
        }
        for (const m of run.messages) if (!m.sent) {
          out.push({ message: { type: "task.message", taskId, text: m.text }, steeringId: m.id });
        }
        if (run.stopping && !this.sentStops.get(peer)?.has(taskId)) out.push({ message: { type: "task.stop", taskId } });
      }
      return out;
    }, context);
    const sent: { taskId: string; id: string }[] = [];
    for (const { message, steeringId } of messages) {
      if (!peer.open()) break;
      peer.send(message);
      if (message.type === "task.stop") this.sentStops.get(peer)?.add(message.taskId);
      if (message.type === "task.message" && steeringId) sent.push({ taskId: message.taskId, id: steeringId });
    }
    if (sent.length) await main.commit(async tx => {
      const tasks = (await tx.doc(Tasks, main.id)).byId;
      for (const { taskId, id } of sent) {
        const run = (await tx.doc(NodeRuns, tasks[taskId]!.conversationId)).byId[taskId]!;
        const m = run.messages.find(m => m.id === id);
        if (m) m.sent = true;
      }
    }, context);
  }

  receive(id: string, peer: NodePeer, msg: Exclude<NodeMessage, Hello>) {
    return this.serial(async () => {
      if (this.peers.get(id) !== peer) throw new Error("Stale connection");
      if (msg.type === "sessions.result") {
        const pending = this.pendingSessions.get(msg.requestId);
        if (pending?.peer === peer && pending.harness === msg.harness) pending.resolve(msg);
        return;
      }
      const main = this.main();
      if (msg.type === "pong") return main.commit(tx => this.touch(tx, id), context);
      const replies = await main.commit(async tx => {
        const task = (await tx.doc(Tasks, main.id)).byId[msg.taskId];
        if (task?.runner?.node !== id) throw new Error("Unknown node task");
        const run = (await tx.doc(NodeRuns, task.conversationId)).byId[msg.taskId]!;
        const answers: HubMessage[] = [];
        if (msg.seq > run.ackSeq + 1) throw new Error("Sequence gap");
        const fresh = msg.seq === run.ackSeq + 1;
        if (fresh && task.status !== "running") throw new Error("Inactive node task");
        if (msg.type === "approval.request") {
          const key = "request-" + msg.requestId;
          const existing = run.approvals[key];
          if (existing?.answer) answers.push({ ...existing.answer });
          else if (fresh && !existing) {
            run.approvals[key] = {};
            await this.requestApproval(tx, task, msg);
          }
        } else if (fresh && msg.type === "task.event") {
          const { at, kind, text = "", tool = "", isError = false } = msg;
          const data: JsonObject = kind === "tool_call" ? { kind, at, tool, arguments: (msg.args ?? null) as JsonValue }
            : kind === "tool_result" ? { kind, at, tool, text, isError }
            : { kind: kind === "text" ? "assistant" : kind, at, text };
          await tx.appendEntry(task.conversationId, { kind: "alter.node-event", data });
          if (kind === "text") run.latestText = text.slice(-300);
          if (kind === "tool_call") run.latestTool = { name: tool, arguments: JSON.stringify(msg.args ?? null).slice(0, 200) };
        } else if (fresh && msg.type === "task.end") {
          if (msg.nativeSessionId) task.nativeSessionId = msg.nativeSessionId;
          await endNodeTask(tx, main, msg.taskId, task, this.now(), msg.status, msg.report, msg.reportSource);
        }
        if (fresh) run.ackSeq = msg.seq;
        await this.touch(tx, id);
        return [{ type: "ack", taskId: msg.taskId, seq: run.ackSeq }, ...answers] satisfies HubMessage[];
      }, context);
      if (msg.type === "task.end") this.sentStops.get(peer)?.delete(msg.taskId);
      for (const m of replies) if (peer.open()) peer.send(m);
    });
  }
  // Also drains tasks created by a schedule or recovered after a hub restart.
  readonly worker = defineTask<string, { phase: "dispatch" }, null>({
    name: "alter.node-dispatch", version: 1, initial: () => ({ phase: "dispatch" }),
    phases: { dispatch: async ({ input }, api, ctx) => {
      await this.flush(input);
      await api.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
    } },
    abort: (_, api, ctx) => api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
}

export const nodeSessionsTool = (nodes: NodeHub) => defineTool({
  name: "node_sessions", description: "List a node agent's existing sessions, newest first. updatedAt is Unix milliseconds.",
  parameters: obj({ node: str({ minLength: 1 }), harness: harnessSchema, cwd: opt(str({ minLength: 1 })) }), replay: "safe",
  async execute({ node, harness, cwd }) {
    try { return reply(JSON.stringify(await nodes.sessions(node, harness, cwd))); }
    catch (error) {
      if (error instanceof NodeSessionsError) return reply(error.message, true);
      throw error;
    }
  },
});
