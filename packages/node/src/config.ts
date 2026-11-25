import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseNodeToken, type HarnessId, type Hello } from "@alter/node-protocol";

export type Platform = Hello["platform"];
export type Config = { nodeId: string; name: string; server: string; token: string; roots: string[]; models?: Partial<Record<HarnessId, string>>;
  paths?: Partial<Record<HarnessId, string>> };

export function configDir(platform = process.platform, home = homedir(), appData = process.env.APPDATA) {
  // Lets one computer run a second node (or a smoke test) without touching the real pairing.
  if (process.env.ALTER_NODE_HOME) return path.resolve(process.env.ALTER_NODE_HOME);
  if (platform === "win32") return path.win32.join(appData || path.win32.join(home, "AppData", "Roaming"), "alter-node");
  if (platform === "darwin") return path.posix.join(home, "Library/Application Support/alter-node");
  if (platform === "linux") return path.posix.join(home, ".config/alter-node");
  throw new Error("不支持此操作系统");
}

export function windowsUserSid() {
  const system = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const output = execFileSync(path.join(system, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  const sid = output.match(/S-1-\d+(?:-\d+)+/i)?.[0];
  if (!sid) throw new Error("无法取得当前用户 SID");
  return sid;
}

function restrictWindowsFile(file: string) {
  const system = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
  execFileSync(path.join(system, "icacls.exe"), [file, "/inheritance:r", "/grant:r", "*" + windowsUserSid() + ":F"], { windowsHide: true });
}

export function atomicWrite(file: string, value: string, privateConfig = false) {
  const tmp = file + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(tmp, "", { flag: "wx", mode: 0o600 });
    if (privateConfig && process.platform === "win32") restrictWindowsFile(tmp);
    writeFileSync(tmp, value, { flush: true });
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
}

// SQLite releases the write lock even when the owner is killed.
export function lock(dir: string, name: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dir, name + ".lock"));
  try { db.exec("BEGIN IMMEDIATE"); }
  catch (err) { db.close(); throw err; }
  return () => db.close();
}

export function loadConfig(dir: string): Config {
  const file = path.join(dir, "config.json");
  if (!existsSync(file)) throw new Error("请先运行 alter-node pair");
  const text = readFileSync(file, "utf8");
  try {
    const c = JSON.parse(text);
    if (typeof c?.nodeId === "string" && typeof c.name === "string" && typeof c.server === "string" &&
      typeof c.token === "string" && parseNodeToken(c.token) && Array.isArray(c.roots) &&
      [c.models, c.paths].every(map => map === undefined || (map !== null && typeof map === "object" && !Array.isArray(map) &&
        Object.values(map).every(value => typeof value === "string" && value.trim()))) &&
      c.roots.every((r: unknown) => typeof r === "string" && path.isAbsolute(r))) return c;
  } catch { /* JSON parser errors can quote a fragment of the token. */ }
  throw new Error("config.json 格式无效");
}

export function saveConfig(dir: string, config: Config) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "config.json");
  atomicWrite(file, JSON.stringify(config, null, 2) + "\n", true);
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

export function directory(input: string) {
  const resolved = realpathSync.native(input);
  if (!statSync(resolved).isDirectory()) throw new Error("需要目录");
  return resolved;
}

function windowsPath(p: string) {
  return p.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "").toLowerCase();
}

export function inside(root: string, cwd: string, platform = process.platform) {
  const api = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") { root = windowsPath(root); cwd = windowsPath(cwd); }
  const rel = api.relative(root, cwd);
  return !api.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + api.sep);
}

export function taskDirectory(roots: string[], requested = roots[0]) {
  if (!requested || !path.isAbsolute(requested)) throw new Error("任务需要已授权的绝对工作目录");
  const cwd = directory(requested);
  if (!roots.some(root => inside(root, cwd))) throw new Error("工作目录超出 roots");
  return cwd;
}

export function pair(dir: string, server: string, token: string, name?: string, roots?: string[]) {
  const release = lock(dir, "config");
  try {
    if (!parseNodeToken(token) || /[^\x21-\x7e]/.test(token)) throw new Error("token 格式无效");
    let url: URL;
    try { url = new URL(server); } catch { throw new Error("server 地址无效"); }
    if (!["https:", "http:", "wss:", "ws:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw new Error("server 需要网关的 origin");
    url.protocol = ["wss:", "https:"].includes(url.protocol) ? "https:" : "http:";
    const old = existsSync(path.join(dir, "config.json")) ? loadConfig(dir) : undefined;
    if (old && (old.server !== url.origin || parseNodeToken(old.token)?.userId !== parseNodeToken(token)?.userId))
      throw new Error("此目录已与其他网关或用户配对");
    const config = { models: old?.models, paths: old?.paths, server: url.origin, token, nodeId: old?.nodeId ?? randomUUID(), name: name || old?.name || hostname(),
      roots: roots ? [...new Set(roots.map(directory))] : old?.roots ?? [] };
    saveConfig(dir, config);
    return config;
  } finally { release(); }
}
