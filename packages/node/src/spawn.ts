import { constants, accessSync, statSync } from "node:fs";
import { execFile, type ChildProcessWithoutNullStreams, type spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { Harness, HarnessId } from "@alter/node-protocol";

const crossSpawn: typeof spawn = createRequire(import.meta.url)("cross-spawn");
export function* commandCandidates(name: string, env = process.env, platform = process.platform) {
  const win = platform === "win32", api = win ? path.win32 : path.posix;
  const extensions = win && !api.extname(name) ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const entry of (env.PATH || env.Path || "").split(api.delimiter)) {
    const dir = win ? entry.replace(/^"(.*)"$/, "$1") : entry;
    if (!api.isAbsolute(dir)) continue;
    for (const ext of extensions) yield api.join(dir, name + ext);
  }
}

export function resolveCommand(name: string, env = process.env) {
  for (const file of commandCandidates(name, env)) {
    try {
      accessSync(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch { /* next PATH entry */ }
  }
}

export function spawnTree(command: string, args: string[], cwd?: string, env = process.env): ChildProcessWithoutNullStreams {
  return crossSpawn(command, args, { cwd, env, stdio: "pipe", windowsHide: true, detached: process.platform !== "win32" });
}

export async function killTree(child: ChildProcessWithoutNullStreams, interrupt?: Promise<unknown>) {
  if (interrupt) {
    const ack = interrupt.catch(() => {});
    // POSIX groups survive a leader exit. Windows taskkill still needs the live parent.
    if (process.platform !== "win32") await Promise.race([ack, sleep(250, undefined, { ref: false })]);
  }
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) {
      const taskkill = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
      try { await promisify(execFile)(taskkill, ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); }
      catch (err) { if (child.exitCode === null && child.signalCode === null) throw err; }
    }
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; }
  }
}

function version(file: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const child = spawnTree(file, ["--version"]);
  return new Promise<string>((resolve, reject) => {
    let output = "";
    const abort = () => { void killTree(child).catch(() => {}); reject(new Error("版本探测已取消或超时")); };
    const timer = setTimeout(abort, 5000);
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.stdout.setEncoding("utf8").on("data", s => { output = (output + s).slice(-2048); });
    child.stderr.resume();
    child.on("error", err => { cleanup(); reject(err); });
    child.on("close", code => {
      cleanup();
      const match = output.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/);
      if (code === 0 && match) resolve(match[0]); else reject(new Error("无法读取版本"));
    });
  });
}

export type Detected = Harness & { executable?: string };
export async function detectHarnesses(env = process.env, signal?: AbortSignal): Promise<Detected[]> {
  const commands: [HarnessId, string][] = [["claude-code", "claude"], ["codex", "codex"], ["opencode", "opencode"]];
  return Promise.all(commands.map(async ([id, command]) => {
    const executable = resolveCommand(command, env);
    if (!executable) return { id, available: false, detail: "未安装 " + command };
    try {
      const v = await version(executable, signal);
      if (id === "opencode") return { id, version: v, available: false, detail: "尚未验证 opencode 2.x HTTP/SSE 协议" };
      return { id, version: v, executable, available: true };
    } catch { return { id, available: false, detail: command + " 版本探测失败" }; }
  }));
}
