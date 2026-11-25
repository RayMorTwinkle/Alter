import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { configDir, directory, inside, loadConfig, lock, pair, taskDirectory } from "../src/config.ts";
import { commandCandidates, desktopCandidates, detectHarnesses, spawnTree } from "../src/spawn.ts";
import { Tasks } from "../src/tasks.ts";
import { workspace } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function fixture() { const f = workspace(); dirs.push(f.base); return f; }

test("pair/status/roots through CLI, durable identity, mode and token secrecy", () => {
  const f = fixture();
  const env = { ...process.env, HOME: f.base, USERPROFILE: f.base, APPDATA: f.base };
  const dir = configDir(process.platform, f.base, f.base);
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const exec = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  const pairArgs = ["pair", "--server", "wss://example.test", "--token", "user.fake-token"];
  expect(exec(...pairArgs, "--name", "猫", "--root", f.root, f.bin)).not.toContain("fake-token");
  const c = loadConfig(dir);
  expect(c).toMatchObject({ name: "猫", server: "https://example.test", roots: [directory(f.root), directory(f.bin)] });
  const model = '["zen","deepseek-v4-flash"]';
  exec("harness", "model", "dsh", model);
  expect(exec(...pairArgs)).toContain(c.nodeId);
  expect(exec("harness", "model", "dsh").trim()).toBe(model);
  exec("harness", "model", "dsh", "--clear");
  expect(loadConfig(dir).models?.dsh).toBeUndefined();
  const shim = path.join(f.bin, "dsh");
  writeFileSync(shim, "");
  exec("harness", "path", "dsh", shim);
  expect(exec(...pairArgs)).toContain(c.nodeId);
  expect(loadConfig(dir).paths?.dsh).toBe(shim);
  exec("harness", "path", "dsh", "--clear");
  expect(exec("harness", "path", "dsh").trim()).toBe("自动查找");
  expect(exec("status")).not.toContain("fake-token");
  if (process.platform !== "win32") expect(statSync(path.join(dir, "config.json")).mode & 0o777).toBe(0o600);
  else {
    const inspect = [
      "$acl = Get-Acl -LiteralPath $env:ALTER_TEST_CONFIG",
      "$rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])",
      "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; count = $rules.Count; current = $rules[0].IdentityReference.Value -eq $sid; rights = $rules[0].FileSystemRights.ToString(); type = $rules[0].AccessControlType.ToString() } | ConvertTo-Json",
    ].join("\n");
    const acl = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", inspect],
      { encoding: "utf8", env: { ...env, ALTER_TEST_CONFIG: path.join(dir, "config.json") } });
    expect(JSON.parse(acl)).toEqual({ protected: true, count: 1, current: true, rights: "FullControl", type: "Allow" });
  }
  expect(exec("roots", "list").trim().split(/\r?\n/)).toEqual(c.roots);
  exec("roots", "remove", f.root); expect(loadConfig(dir).roots).toEqual([directory(f.bin)]);
  exec("roots", "add", f.root); expect(loadConfig(dir).roots).toEqual([directory(f.bin), directory(f.root)]);
  const bad = spawnSync(process.execPath, [cli, "pair", "--server", "invalid", "--token", "secret-marker"], { env, encoding: "utf8" });
  expect(bad.status).toBe(1); expect(bad.stdout + bad.stderr).not.toContain("secret-marker");
  expect(() => pair(dir, "https://elsewhere.test", "other.token")).toThrow("配对");
});

test("platform directories, drive boundaries, device prefix and UNC case", () => {
  expect(configDir("darwin", "/home/me")).toBe("/home/me/Library/Application Support/alter-node");
  expect(configDir("linux", "/home/me")).toBe("/home/me/.config/alter-node");
  expect(configDir("win32", "C:\\Users\\me", "D:\\Roaming")).toBe("D:\\Roaming\\alter-node");
  expect([...commandCandidates("codex", { Path: 'relative;"D:\\Node JS";C:\\bin', PATHEXT: ".EXE;.CMD" }, "win32")])
    .toEqual(["D:\\Node JS\\codex.EXE", "D:\\Node JS\\codex.CMD", "C:\\bin\\codex.EXE", "C:\\bin\\codex.CMD"]);
  const win = (root: string, cwd: string) => inside(root, cwd, "win32");
  expect(win("C:\\代码", "\\\\?\\c:\\代码\\app")).toBe(true);
  expect(win("\\\\server\\share\\Code", "\\\\?\\UNC\\SERVER\\share\\code\\Sub")).toBe(true);
  expect(win("C:\\Code", "C:\\Code2")).toBe(false);
  expect(win("C:\\Code", "D:\\Code")).toBe(false);
  expect(win("C:\\Code", "C:\\Code\\..\\else")).toBe(false);
});

test("realpath rejects symlinks and junctions that escape the root", () => {
  const f = fixture(), root = directory(f.root);
  mkdirSync(path.join(root, "..local"));
  symlinkSync(f.bin, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  expect(taskDirectory([root])).toBe(root);
  expect(taskDirectory([root], path.join(root, "..local"))).toBe(path.join(root, "..local"));
  expect(() => taskDirectory([root], path.join(root, "escape"))).toThrow("roots");
  expect(() => taskDirectory([], undefined)).toThrow();
  expect(() => taskDirectory([root], ".")).toThrow();
});

test("probes only the supplied executables, including .cmd shims on Windows", async () => {
  const f = fixture();
  if (process.platform === "win32") writeFileSync(path.join(f.bin, "claude.ps1"), "exit 1");
  const detected = await detectHarnesses({ PATH: f.bin, PATHEXT: ".PS1;.CMD;.EXE" });
  expect(detected).toMatchObject([{ id: "claude-code", available: true, version: "1.2.3" },
    { id: "codex", available: true, version: "1.2.3" }, { id: "opencode", available: true, sessions: true, version: "1.2.3" },
    { id: "dsh", available: true, sessions: true, version: "1.2.3" }]);
  expect((await detectHarnesses({ PATH: "" }, undefined, {}, async () => [])).every(h => !h.available && h.detail)).toBe(true);
});

test("falls back to a desktop app's bundled CLI and honours a configured path", async () => {
  const f = fixture(), dsh = (await detectHarnesses({ PATH: f.bin, PATHEXT: ".CMD" })).find(h => h.id === "dsh")!.executable!;
  const offPath = async (id: string) => id === "dsh" ? [path.join(f.root, "missing"), dsh] : [];
  const found = await detectHarnesses({ PATH: "" }, undefined, {}, offPath);
  expect(found.find(h => h.id === "dsh")).toMatchObject({ available: true, executable: dsh });
  expect(found.find(h => h.id === "codex")?.available).toBe(false);
  const configured = await detectHarnesses({ PATH: "" }, undefined, { codex: dsh, opencode: path.join(f.root, "nope") }, async () => []);
  expect(configured.find(h => h.id === "codex")).toMatchObject({ available: true, executable: dsh });
  expect(configured.find(h => h.id === "opencode")?.detail).toContain("不存在");
});

test("desktop candidates point at the bundled DeepSeek Harness CLI", async () => {
  expect(await desktopCandidates("dsh", { HOME: "/Users/me" }, "darwin")).toEqual([
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
    "/Users/me/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"]);
  expect(await desktopCandidates("codex", {}, "darwin")).toEqual([]);
});

test("the harness wrapper preserves argument boundaries and Unicode", async () => {
  const f = fixture();
  const args = ["中文 目录", '名称="two words"', "A & B", "C:\\有空格 的路径\\", ""];
  const child = spawnTree(f.harnesses[0]!.executable!, ["--echo-argv", ...args], f.root);
  let output = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
  child.stdin.end();
  expect((await once(child, "close"))[0]).toBe(0);
  expect(JSON.parse(output)).toEqual(args);
});

test("journal survives a torn tail, reports an interrupted host once and preserves the terminal ack", () => {
  const f = fixture();
  const t = new Tasks(f.dir, [], () => {});
  const id = "../opaque:task";
  t.box.append(id, { type: "task.event", kind: "text", text: "最后的输出" });
  t.box.append("normal", { type: "task.event", kind: "status", text: "started" });
  appendFileSync(path.join(f.dir, "outbox/normal.jsonl"), '{"seq":2');
  const recovered = new Tasks(f.dir, [], () => {});
  expect(recovered.box.tasks()).toEqual(expect.arrayContaining([{ taskId: id, state: "ended", lastSeq: 2 }]));
  expect(recovered.box.journals.get(id)?.at(-1)).toMatchObject({ reportSource: "failure", report: { summary: expect.stringContaining("最后的输出") } });
  expect(existsSync(path.join(f.dir, "opaque:task.jsonl"))).toBe(false);
  recovered.replay({ normal: 2 });
  const restarted = new Tasks(f.dir, [], () => {});
  expect(restarted.box.known("normal")).toBe(true); expect(restarted.box.tasks()).toHaveLength(1);
  expect(restarted.box.journals.get(id)).toHaveLength(2);
  const release = lock(f.dir, "run");
  try { expect(() => lock(f.dir, "run")).toThrow(); } finally { release(); }
});
