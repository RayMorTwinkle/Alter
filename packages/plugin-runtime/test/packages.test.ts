import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inspect } from "../src/packages.ts";
import { run } from "../src/process.ts";
import { openStore } from "../src/store.ts";
import { fixture, manifest } from "./fixtures.ts";

function npmFixture() {
  const f = fixture();
  const pkg = { name: "fixture", version: "1.0.0", dependencies: { message: "file:vendor/message" },
    scripts: { install: "node -e \"require('fs').writeFileSync('script-ran','unexpected')\"" } };
  const vendor = join(f.pkg, "vendor/message");
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, "package.json"), JSON.stringify({ name: "message", version: "1.0.0", main: "index.cjs" }));
  writeFileSync(join(vendor, "index.cjs"), 'module.exports = "from dependency";');
  writeFileSync(join(f.pkg, "index.mjs"), 'import message from "message"; export default {tools:{read:()=>message}}');
  writeFileSync(join(f.pkg, "package.json"), JSON.stringify(pkg));
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {
    "": { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies },
    "vendor/message": { name: "message", version: "1.0.0" },
    "node_modules/message": { resolved: "vendor/message", link: true },
  } };
  return { ...f, store: openStore(f.data), lockPath: join(f.pkg, "package-lock.json"), lock };
}

it("installs locked dependencies before approval and runs the approved snapshot with the installed modules", async () => {
  const { pkg, data, store, lockPath, lock, write } = npmFixture();
  write({ ...manifest, requires: ["adb（读取设备信息）", "已连接的安卓手机"],
    network: [{ host: "example.com", methods: ["POST"], pathPrefixes: ["/events"] }] });
  writeFileSync(lockPath, JSON.stringify(lock));
  const first = inspect(pkg).sha;
  mkdirSync(join(pkg, "node_modules"));
  writeFileSync(join(pkg, "node_modules", "untrusted-input"), "ignored");
  expect(inspect(pkg).sha).toBe(first);
  const pending = await store.propose(pkg);
  expect(pending.sha).toBe(first);
  expect(pending.summary.split("\n")[0]).toBe("此插件以你的权限运行，可以读写文件、联网、执行命令");
  for (const label of ["message@file:vendor/message", "adb（读取设备信息）", "已连接的安卓手机",
    "POST https://example.com/events", "token", "Fixture", "read", "读取数据", "订阅 feed"]) expect(pending.summary).toContain(label);
  expect(pending.dependencies).toEqual({ message: "file:vendor/message" });
  expect(existsSync(join(pkg, "node_modules/message"))).toBe(false);
  expect(existsSync(join(data, "plugins/packages", first))).toBe(false);
  const persisted = openStore(data);
  await persisted.approve("sample", first);
  const dir = persisted.directory(first);
  expect(existsSync(join(dir, "script-ran"))).toBe(false);
  expect(existsSync(join(dir, "node_modules/untrusted-input"))).toBe(false);
  await expect(run(dir, manifest.resources, { kind: "tools", name: "read", args: {} }, async () => null, AbortSignal.timeout(5000), []))
    .resolves.toBe("from dependency");
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock, null, 2));
  expect(() => persisted.directory(first)).toThrow("mismatch");
});

it("rejects missing or inconsistent locks without replacing a valid pending proposal", async () => {
  const { pkg, store, lockPath, lock } = npmFixture();
  await expect(store.propose(pkg)).rejects.toThrow("require package-lock");
  expect(store.list()).toEqual([]);
  writeFileSync(lockPath, JSON.stringify(lock));
  const original = await store.propose(pkg);
  writeFileSync(lockPath, JSON.stringify({ ...lock, packages: { "": lock.packages[""] } }));
  await expect(store.propose(pkg)).rejects.toThrow("npm ci");
  expect(store.view("sample").pending?.sha).toBe(original.sha);
});

it("keeps local npm dependencies inside the reviewed package", async () => {
  const { pkg, store, lockPath, lock } = npmFixture();
  lock.packages["node_modules/message"].resolved = "../outside";
  writeFileSync(lockPath, JSON.stringify(lock));
  await expect(store.propose(pkg)).rejects.toThrow("inside the plugin package");
  expect(store.list()).toEqual([]);
});

it("requires fresh user approval for a hash previously approved under the old permissions", async () => {
  const { data, pkg } = fixture(), store = openStore(data);
  const { sha } = await store.propose(pkg);
  await store.approve("sample", sha);
  const registry = join(data, "plugins", "registry.json");
  const old = JSON.parse(readFileSync(registry, "utf8"));
  delete old.sample.versions[0].userApproved;
  old.sample.versions[0].kv = { keep: true };
  writeFileSync(registry, JSON.stringify(old));
  const migrated = openStore(data);
  expect(migrated.view("sample")).toMatchObject({ status: "disabled", pending: { sha } });
  await migrated.approve("sample", sha);
  expect(openStore(data).active("sample")).toMatchObject({ userApproved: true, status: "enabled", kv: { keep: true } });
});
