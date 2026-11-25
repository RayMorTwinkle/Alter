import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { configDir, directory, inside, loadConfig, lock, pair, taskDirectory } from "../src/config.ts";
import { commandCandidates, detectHarnesses } from "../src/spawn.ts";
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
  expect(exec(...pairArgs)).toContain(c.nodeId);
  expect(exec("status")).not.toContain("fake-token");
  if (process.platform !== "win32") expect(statSync(path.join(dir, "config.json")).mode & 0o777).toBe(0o600);
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
  const detected = await detectHarnesses({ PATH: f.bin });
  expect(detected).toMatchObject([{ id: "claude-code", available: true, version: "1.2.3" },
    { id: "codex", available: true, version: "1.2.3" }, { id: "opencode", available: false, version: "1.2.3" }]);
  expect((await detectHarnesses({ PATH: "" })).every(h => !h.available && h.detail)).toBe(true);
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
