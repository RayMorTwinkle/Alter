import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { NetworkViolation } from "./http.ts";
import { launchSandbox } from "./seatbelt.ts";
import { check, record, type Manifest } from "./manifest.ts";

const worker = readFileSync(new URL("./worker.mjs", import.meta.url), "utf8");
let sdk: string | undefined;
export type Invoke = { kind: "sources" | "tools"; name: string; args: unknown };
export type HostCall = (method: string, params: unknown) => Promise<unknown>;
const limit = 4 * 1024 * 1024;
export function run(directory: string, resources: Manifest["resources"], call: Invoke, host: HostCall,
  signal: AbortSignal, secrets: string[]): Promise<unknown> {
  signal.throwIfAborted();
  directory = realpathSync(directory);
  sdk ??= "data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(
    readFileSync(new URL(import.meta.resolve("@alter/plugin-sdk")), "utf8"))).toString("base64");
  function serialize(msg: Record<string, unknown>) {
    const line = JSON.stringify({ jsonrpc: "2.0", ...msg }, (key, v: unknown) => {
      check(!secrets.some(s => s && (key.includes(s) || typeof v === "string" && v.includes(s))), "Credential withheld");
      return v;
    });
    check(!secrets.some(s => s && line.includes(s)), "Credential withheld");
    check(Buffer.byteLength(line) <= limit, "RPC frame exceeds 4 MiB");
    return line + "\n";
  }
  const first = serialize({ id: "invoke", method: "invoke", params: call });
  const child = launchSandbox(directory, [
    "--jitless", "--permission", "--allow-fs-read=" + directory, "--no-addons", "--max-old-space-size=" + resources.memoryMB,
    "--input-type=module", "-e", worker, "--", sdk]);
  return new Promise((resolve, reject) => {
    let done = false, busy = false, checking = false, calls = 0, bytes = 0;
    let chunks: Buffer[] = [];
    function end(err?: Error, result?: unknown) {
      if (done) return;
      done = true;
      clearTimeout(deadline); clearInterval(memory);
      signal.removeEventListener("abort", abort);
      child.kill("SIGKILL");
      if (err) reject(err); else resolve(result);
    }
    const abort = () => end(new Error("Plugin invocation stopped"));
    const deadline = setTimeout(() => end(new Error("Plugin timeout")), resources.timeoutMs);
    const memory = setInterval(() => {
      if (checking || !child.pid) return;
      checking = true;
      execFile("/bin/ps", ["-o", "rss=", "-p", String(child.pid)], { timeout: 1000 }, (err, stdout) => {
        checking = false;
        if (err || !Number(stdout)) end(new Error("Plugin memory monitor failed"));
        else if (Number(stdout) > resources.memoryMB * 1024) end(new Error("Plugin memory limit exceeded"));
      });
    }, 100);
    signal.addEventListener("abort", abort, { once: true });
    async function receive(line: string) {
      const m: unknown = JSON.parse(line);
      check(record(m) && m.jsonrpc === "2.0" && !busy, "Invalid or concurrent RPC frame");
      if (m.id === "invoke" && !("method" in m)) {
        check(!("error" in m) && Object.hasOwn(m, "result"), "Plugin invocation failed");
        end(undefined, m.result); return;
      }
      check(Number.isSafeInteger(m.id) && m.id === ++calls && calls <= 512 && typeof m.method === "string", "Invalid RPC request");
      busy = true;
      let response: string;
      try { response = serialize({ id: m.id, result: (await host(m.method, m.params)) ?? null }); }
      catch { response = serialize({ id: m.id, error: { code: -32001, message: "Host request refused" } }); }
      busy = false;
      if (!done) child.stdin.write(response);
    }
    child.stdout.on("data", (data: Buffer) => {
      let pos = 0;
      while (!done && pos < data.length) {
        const nl = data.indexOf(10, pos);
        const chunk = data.subarray(pos, nl < 0 ? data.length : nl);
        bytes += chunk.length;
        if (bytes > limit) { end(new Error("RPC frame exceeds 4 MiB")); return; }
        chunks.push(chunk);
        if (nl < 0) break;
        void receive(Buffer.concat(chunks, bytes).toString("utf8")).catch(() => end(new Error("Plugin protocol or execution failed")));
        bytes = 0; chunks = []; pos = nl + 1;
      }
    });
    let seatbeltDenied = false;
    child.stderr.on("data", (chunk: Buffer) => { if (chunk.includes("sandbox_apply: Operation not permitted")) seatbeltDenied = true; });
    child.on("error", () => end(new Error("Unable to start macOS sandbox")));
    child.stdin.on("error", () => end(new Error("Plugin input closed")));
    child.on("close", (_, sig) => end(sig === "SIGKILL" ? new NetworkViolation("Sandboxed process killed by the system") :
      new Error(seatbeltDenied ? "macOS refused sandbox_apply" : "Sandboxed plugin exited")));
    child.stdin.write(first);
  });
}
