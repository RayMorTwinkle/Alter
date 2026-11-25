// ACP and Codex app-server both frame stdio messages with newlines.
import { createInterface } from "node:readline";
import { killTree, spawnTree } from "../spawn.ts";

type Frame = { id?: number | string; method?: string; params?: unknown; result?: unknown;
  error?: { code?: number; message: string; data?: unknown } };

export function stdioRpc(command: string, args: string[], cwd: string, jsonrpc: boolean,
  onMethod?: (method: string, params: unknown, request: boolean) => Promise<unknown>, env?: NodeJS.ProcessEnv) {
  const child = spawnTree(command, args, cwd, env);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map<number, { resolve(result: unknown): void; reject(error: Error): void }>();
  let serial = 0, stderr = "", failure: Error | undefined;
  function fail(error: Error) {
    failure ??= error;
    for (const call of pending.values()) call.reject(failure);
    pending.clear();
  }
  function write(frame: Frame) {
    if (failure) return;
    child.stdin.write(JSON.stringify({ ...(jsonrpc && { jsonrpc: "2.0" }), ...frame }) + "\n");
  }
  async function receive(frame: Frame) {
    const { id, method } = frame;
    if (method) {
      const result = await onMethod?.(method, frame.params, id !== undefined);
      if (id !== undefined) write(result === undefined
        ? { id, error: { code: -32601, message: "Unsupported method" } }
        : { id, result });
    } else if (typeof id === "number") {
      const call = pending.get(id);
      pending.delete(id);
      if (frame.error) {
        const detail = frame.error.data;
        call?.reject(new Error([frame.error.message, typeof detail === "string" ? detail : JSON.stringify(detail)].filter(Boolean).join(" ")));
      } else call?.resolve(frame.result);
    }
  }
  child.stderr.setEncoding("utf8").on("data", s => { stderr = (stderr + s).slice(-2000); });
  lines.on("line", line => {
    if (failure || !line.trim()) return;
    try { void receive(JSON.parse(line)).catch(fail); }
    catch { fail(new Error("代理返回无效 JSON")); }
  });
  child.stdin.on("error", fail);
  child.on("error", fail);
  lines.once("close", () => fail(new Error("代理消息流关闭 " + stderr.trim())));
  child.once("exit", (code, signal) => {
    setTimeout(() => fail(new Error("代理进程退出 (" + (code ?? signal) + ") " + stderr.trim())), 100).unref();
  });
  return {
    request<T>(method: string, params: object): Promise<T> {
      if (failure) return Promise.reject(failure);
      const id = ++serial;
      const call = Promise.withResolvers<unknown>();
      pending.set(id, call);
      write({ id, method, params });
      return call.promise as Promise<T>;
    },
    notify(method: string, params?: object) { write({ method, params }); },
    async close(grace?: Promise<unknown>) {
      try { await killTree(child, grace); }
      finally { fail(new Error("代理连接已关闭")); lines.close(); }
    },
  };
}
