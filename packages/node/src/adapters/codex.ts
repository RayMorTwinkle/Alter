import { createInterface } from "node:readline";
import { killTree, spawnTree } from "../spawn.ts";
import type { HarnessAdapter } from "./types.ts";

// Codex 0.166 alpha, app-server v2. Keep experimental method names, enums and TOML overrides here.
type Item = { id: string; type: string; text?: string; command?: string; aggregatedOutput?: string;
  changes?: unknown; server?: string; tool?: string; arguments?: unknown; result?: unknown; status?: string };
type Turn = { id: string; status: string; error?: { message?: string } };
type Result = { thread?: { id: string }; turn?: Turn };
type Frame = { id?: number | string; method?: string; result?: Result; error?: { message: string };
  params?: { threadId?: string; turnId?: string; itemId?: string; delta?: string; item?: Item; turn?: Turn } };

export const codex: HarnessAdapter = {
  start(task, sink) {
    const policy = { restricted: "untrusted", auto: "on-request", full: "never" }[task.permission];
    const sandbox = task.permission === "restricted" ? "read-only" : "workspace-write";
    const mcp = "mcp_servers.alter.";
    const child = spawnTree(task.executable, ["app-server", "--listen", "stdio://",
      "-c", mcp + "command=" + JSON.stringify(task.finish.command), "-c", mcp + "args=" + JSON.stringify(task.finish.args)], task.cwd);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let serial = 0, thread = "", turn = "", stopped = false, stderr = "", generation = 0;
    let stopping = false;
    const partial = new Map<string, string>();
    const pending = new Map<number, { resolve(r: Result): void; reject(e: Error): void }>();
    const write = (frame: object) => { if (!stopped) child.stdin.write(JSON.stringify(frame) + "\n"); };
    function rpc(method: string, params: object, bind?: (result: Result) => void) {
      return new Promise<Result>((resolve, reject) => {
        const id = ++serial;
        pending.set(id, { resolve(result) { bind?.(result); resolve(result); }, reject });
        write({ id, method, params });
      });
    }
    const fail = (reason: string) => { if (!stopped) sink.turn({ status: "failed", reason }); };
    async function message(text: string) {
      const current = ++generation;
      partial.clear(); turn = "";
      const response = await rpc("turn/start", { threadId: thread, input: [{ type: "text", text, text_elements: [] }],
        ...(task.thinking && { effort: task.thinking === "max" ? "xhigh" : task.thinking }) }, result => {
        // readline may deliver notifications in the same chunk as the start response.
        if (current === generation && result.turn?.id) turn = result.turn.id;
      });
      if (current !== generation || stopped) return;
      if (!response.turn?.id) throw new Error("turn/start 缺少 turn.id");
    }
    async function receive(frame: Frame) {
      const { id, method, params: p = {} } = frame;
      if (!method) {
        const request = typeof id === "number" ? pending.get(id) : undefined;
        if (request && typeof id === "number") {
          pending.delete(id);
          if (frame.error) request.reject(new Error(frame.error.message)); else request.resolve(frame.result ?? {});
        }
        return;
      }
      if (stopping) return;
      if (id !== undefined) {
        const tool = method === "item/commandExecution/requestApproval" ? "exec_command"
          : method === "item/fileChange/requestApproval" ? "apply_patch" : undefined;
        if (!tool) { write({ id, error: { code: -32601, message: "Unsupported request" } }); return; }
        if (!thread || p.threadId !== thread || !turn || p.turnId !== turn) { write({ id, result: { decision: "decline" } }); return; }
        const a = await sink.approve(tool, p);
        if (stopping) return;
        const denied = a.decision === "deny" || p.turnId !== turn;
        // v2 accepts only a decision enum. Steer the current turn to deliver the user's note.
        if (!stopped && p.turnId === turn && denied && a.note) {
          void rpc("turn/steer", { threadId: thread, expectedTurnId: turn, input: [{ type: "text",
            text: "审批拒绝：" + a.note, text_elements: [] }] }).catch(err => fail(String(err)));
        }
        write({ id, result: { decision: denied ? "decline" : "accept" } });
        return;
      }
      if (!thread || p.threadId !== thread) return;
      if (method === "turn/started" && p.turn && !turn) turn = p.turn.id;
      if (p.turnId && p.turnId !== turn) return;
      const item = p.item;
      if (method === "item/agentMessage/delta" && p.itemId && p.delta) {
        const text = (partial.get(p.itemId) ?? "") + p.delta;
        partial.set(p.itemId, text); sink.assistant(text); sink.event({ kind: "text", text: p.delta });
      } else if (method === "item/completed" && item?.type === "agentMessage") {
        const body = item.text || partial.get(item.id);
        if (body?.trim()) {
          sink.assistant(body);
          const seen = partial.get(item.id) ?? "";
          if (body.startsWith(seen) && body.length > seen.length) sink.event({ kind: "text", text: body.slice(seen.length) });
        }
        partial.delete(item.id);
      } else if ((method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") && p.delta) {
        sink.event({ kind: "thinking", text: p.delta });
      } else if ((method === "item/started" || method === "item/completed") && item &&
        ["commandExecution", "fileChange", "mcpToolCall"].includes(item.type)) {
        if (method === "item/started") sink.event({ kind: "tool_call", tool: item.tool || item.type, args: item.arguments ?? item.changes ?? item.command });
        else sink.event({ kind: "tool_result", tool: item.tool || item.type,
          text: item.aggregatedOutput ?? JSON.stringify(item.result ?? item.changes), isError: item.status === "failed" });
      } else if (method === "turn/completed" && p.turn && turn === p.turn.id) {
        const status = p.turn.status;
        sink.turn({ status: status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed",
          reason: p.turn.error?.message || (status === "completed" ? undefined : status) });
      }
    }
    child.stderr.setEncoding("utf8").on("data", s => { stderr = (stderr + s).slice(-2000); });
    lines.on("line", line => {
      if (!line.trim() || stopped) return;
      try { void receive(JSON.parse(line)).catch(err => fail(String(err))); }
      catch { fail("Codex 返回无效 JSON"); }
    });
    child.stdin.on("error", err => fail(err.message));
    child.on("error", err => fail(err.message));
    lines.once("close", () => fail("Codex 消息流在轮结束前关闭 " + stderr.trim()));
    child.once("exit", (code, signal) => {
      // Allow buffered terminal frames to drain, even when a grandchild keeps stdout open.
      setTimeout(() => fail("Codex 在轮结束前退出 (" + (code ?? signal) + ") " + stderr.trim()), 100).unref();
    });
    void (async () => {
      await rpc("initialize", { clientInfo: { name: "alter-node", version: "1" }, capabilities: { experimentalApi: true } });
      if (stopping) return;
      write({ method: "initialized" });
      const result = await rpc(task.resume ? "thread/resume" : "thread/start",
        { cwd: task.cwd, approvalPolicy: policy, sandbox, ...(task.resume && { threadId: task.resume }) });
      if (stopping) return;
      if (!result.thread?.id) throw new Error("缺少 thread.id");
      thread = result.thread.id; sink.session(thread);
      await message(task.brief);
    })().catch(err => fail(String(err)));
    return { message, async stop(interrupt) {
      stopping = true;
      const ack = interrupt && thread && turn && child.exitCode === null && child.signalCode === null
        ? rpc("turn/interrupt", { threadId: thread, turnId: turn }) : undefined;
      try { await killTree(child, ack); } finally {
        stopped = true;
        for (const r of pending.values()) r.reject(new Error("任务已结束"));
        pending.clear(); lines.close();
      }
    } };
  },
};
