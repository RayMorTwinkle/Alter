import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { withholdCredentials } from "./credentials.ts";
import { pluginEnvironment } from "./environment.ts";
import { check, record, type Manifest } from "./manifest.ts";

const worker = readFileSync(new URL("./worker.mjs", import.meta.url), "utf8");
let sdk: string | undefined;
export type Invoke = { kind: "sources" | "tools"; name: string; args: unknown };
export type HostCall = (method: string, params: unknown) => Promise<unknown>;
const limit = 4 * 1024 * 1024;
function frame(msg: Record<string, unknown>) {
  const line = JSON.stringify({ jsonrpc: "2.0", ...msg });
  check(Buffer.byteLength(line) <= limit, "RPC frame exceeds 4 MiB");
  return line + "\n";
}

type Pending = {
  host: HostCall; requests: number; cancelled: boolean;
  finish(error?: Error, result?: unknown): void;
  timer: NodeJS.Timeout;
};
export class WorkerReset extends Error {}

export function createWorkerHost(directory: string, resources: Manifest["resources"], secrets: string[], secretNames: string[] = []) {
  sdk ??= "data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(
    readFileSync(new URL(import.meta.resolve("@alter/plugin-sdk")), "utf8"))).toString("base64");
  const child = spawn(process.execPath, ["--max-old-space-size=" + resources.memoryMB,
    "--input-type=module", "-e", worker, "--", sdk, String(resources.memoryMB)], {
    cwd: realpathSync(directory), env: pluginEnvironment(secretNames, secrets), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const calls = new Map<string, Pending>();
  let seq = 0, available = true, memoryExceeded = false;
  let grace: NodeJS.Timeout | undefined;
  const exited = new Promise<void>(resolve => child.once("close", () => {
    shutdown(new Error(memoryExceeded ? "Plugin memory limit exceeded" : "Plugin process exited"));
    clearTimeout(grace);
    resolve();
  }));
  function finish(id: string, error?: Error, result?: unknown) {
    const call = calls.get(id);
    if (!call) return;
    calls.delete(id);
    clearTimeout(call.timer);
    call.finish(error, result);
  }
  function shutdown(error: Error) {
    available = false;
    for (const id of calls.keys()) finish(id, error);
  }
  function kill(error: Error) {
    shutdown(error);
    child.kill("SIGKILL");
  }
  function close() {
    if (available) {
      shutdown(new WorkerReset("Plugin invocation stopped"));
      child.stdin.write(frame({ method: "close" }));
      grace = setTimeout(() => child.kill("SIGKILL"), 500);
    }
    return exited;
  }
  async function receive(line: string) {
    const m: unknown = JSON.parse(line);
    check(record(m) && m.jsonrpc === "2.0" && typeof m.callId === "string", "Invalid RPC frame");
    const call = calls.get(m.callId);
    check(call, "Unknown invocation");
    if (!("method" in m)) {
      if (m.error || !Object.hasOwn(m, "result")) finish(m.callId, new Error("Plugin invocation failed"));
      else {
        try { withholdCredentials(m.result, secrets); }
        catch { finish(m.callId, new Error("Credential withheld")); return; }
        finish(m.callId, undefined, m.result);
      }
      return;
    }
    check(typeof m.method === "string" && m.id === ++call.requests && call.requests <= 512, "Invalid RPC request");
    let response: string;
    try {
      check(!call.cancelled, "Invocation stopped");
      if (m.method !== "secrets.get") withholdCredentials(m.params, secrets);
      const result = (await call.host(m.method, m.params)) ?? null;
      if (m.method === "secrets.get") {
        check(record(m.params) && typeof m.params.name === "string" && secretNames.includes(m.params.name)
          && (result === null || typeof result === "string"), "Undeclared secret");
      } else withholdCredentials(result, secrets);
      response = frame({ callId: m.callId, id: m.id, result });
    } catch {
      response = frame({ callId: m.callId, id: m.id, error: { code: -32001, message: "Host request refused" } });
    }
    if (available && calls.has(m.callId)) child.stdin.write(response);
  }
  let bytes = 0, chunks: Buffer[] = [];
  child.stdout.on("data", (data: Buffer) => {
    let pos = 0;
    while (available && pos < data.length) {
      const nl = data.indexOf(10, pos);
      const chunk = data.subarray(pos, nl < 0 ? data.length : nl);
      bytes += chunk.length;
      if (bytes > limit) { kill(new Error("RPC frame exceeds 4 MiB")); return; }
      chunks.push(chunk);
      if (nl < 0) break;
      void receive(Buffer.concat(chunks, bytes).toString("utf8")).catch(() => kill(new Error("Plugin protocol or execution failed")));
      chunks = []; bytes = 0; pos = nl + 1;
    }
  });
  child.stderr.on("data", (data: Buffer) => {
    if (data.includes("ALTER_PLUGIN_RSS_LIMIT") || data.includes("heap out of memory")) memoryExceeded = true;
  });
  // A spawned CLI can inherit these descriptors and outlive the worker.
  // Release our pipes after exit so shutdown never waits for that CLI to exit.
  child.once("exit", () => setImmediate(() => {
    child.stdout.destroy();
    child.stderr.destroy();
  }));
  child.on("error", () => kill(new Error("Unable to start plugin process")));
  child.stdin.on("error", () => child.kill("SIGKILL"));
  function invoke(call: Invoke, host: HostCall, signal: AbortSignal) {
    signal.throwIfAborted();
    check(available, "Worker closed");
    withholdCredentials(call, secrets);
    const callId = String(++seq);
    const first = frame({ callId, method: "invoke", params: call });
    return new Promise<unknown>((resolve, reject) => {
      // A cancelled plugin can still execute native/user code. Revoke its RPCs
      // immediately and retain its original deadline until it actually returns.
      const abort = () => {
        const pending = calls.get(callId)!;
        pending.cancelled = true;
        child.stdin.write(frame({ callId, method: "cancel" }));
        reject(new Error("Plugin invocation stopped"));
      };
      const timer = setTimeout(() => {
        finish(callId, new Error("Plugin timeout"));
        kill(new WorkerReset("Plugin worker reset after invocation timeout"));
      }, resources.timeoutMs);
      calls.set(callId, { host, requests: 0, timer, cancelled: false, finish(error, result) {
        signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(result);
      } });
      signal.addEventListener("abort", abort, { once: true });
      child.stdin.write(first);
    });
  }
  return { invoke, close, exited, get available() { return available; } };
}

export function run(directory: string, resources: Manifest["resources"], call: Invoke, host: HostCall,
  signal: AbortSignal, secrets: string[], secretNames: string[] = []): Promise<unknown> {
  signal.throwIfAborted();
  withholdCredentials(call, secrets);
  const worker = createWorkerHost(directory, resources, secrets, secretNames);
  try { return worker.invoke(call, host, signal).finally(() => { void worker.close(); }); }
  catch (error) { void worker.close(); throw error; }
}
