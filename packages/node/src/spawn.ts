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
  const extensions = win && !api.extname(name) ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
    .filter(ext => /^\.(?:com|exe|bat|cmd)$/i.test(ext)) : [""];
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
export const harnessCommands = { "claude-code": "claude", codex: "codex", opencode: "opencode", dsh: "dsh" } satisfies Record<HarnessId, string>;

function existingFile(file: string) {
  try { return statSync(file).isFile() ? file : undefined; } catch { return undefined; }
}

// Windows installers record where they put the app; the DeepSeek Harness desktop installer lets
// users pick any folder, so the uninstall entry is the only reliable pointer.
async function windowsInstallDirs(displayName: string) {
  const reg = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
  const run = (args: string[]) => promisify(execFile)(reg, args, { windowsHide: true, timeout: 5000 }).then(r => r.stdout, () => "");
  const dirs: string[] = [];
  for (const hive of ["HKCU", "HKLM"]) {
    const found = await run(["query", hive + "\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "/s", "/f", displayName, "/d", "/e"]);
    for (const key of found.split(/\r?\n/).filter(line => /^HKEY_/.test(line))) {
      const values = await run(["query", key.trim()]);
      const value = (name: string) => values.match(new RegExp("^\\s*" + name + "\\s+REG_\\w+\\s+(.+)$", "m"))?.[1]?.trim();
      const location = value("InstallLocation")?.replace(/^"(.*)"$/, "$1");
      const icon = value("DisplayIcon")?.replace(/,\d+$/, "").replace(/^"(.*)"$/, "$1");
      const dir = location || (icon && path.win32.dirname(icon));
      if (dir) dirs.push(dir);
    }
  }
  return dirs;
}

// Desktop apps that bundle a CLI outside PATH. Most people install DeepSeek Harness as the desktop
// app, and the npm build of dsh is unreliable on Windows.
export async function desktopCandidates(id: HarnessId, env = process.env, platform = process.platform) {
  if (id !== "dsh") return [];
  if (platform === "win32") {
    const defaults = [env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs", "DeepSeek Harness"),
      env.ProgramFiles && path.win32.join(env.ProgramFiles, "DeepSeek Harness")].filter(Boolean) as string[];
    return [...await windowsInstallDirs("DeepSeek Harness"), ...defaults]
      .map(dir => path.win32.join(dir, "resources", "runtime", "cli", "bin", "dsh.cmd"));
  }
  if (platform === "darwin") {
    return ["/Applications", env.HOME && path.posix.join(env.HOME, "Applications")].filter(Boolean)
      .map(dir => path.posix.join(dir!, "DeepSeek Harness.app", "Contents", "Resources", "runtime", "cli", "bin", "dsh"));
  }
  return [];
}

export async function detectHarnesses(env = process.env, signal?: AbortSignal,
  paths: Partial<Record<HarnessId, string>> = {}, desktop = desktopCandidates): Promise<Detected[]> {
  const commands = Object.entries(harnessCommands) as [HarnessId, string][];
  return Promise.all(commands.map(async ([id, command]) => {
    const configured = paths[id];
    if (configured && !existingFile(configured)) return { id, available: false, detail: "指定的路径不存在：" + configured };
    let executable = configured || resolveCommand(command, env);
    for (const file of executable ? [] : await desktop(id, env)) if ((executable = existingFile(file))) break;
    if (!executable) return { id, available: false, detail: "未安装 " + command };
    try {
      const v = await version(executable, signal);
      return { id, version: v, executable, available: true, sessions: true };
    } catch { return { id, available: false, detail: command + " 版本探测失败" }; }
  }));
}
