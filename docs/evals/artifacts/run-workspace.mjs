/** Run from each clean revision after a frozen pnpm install. Outputs go to the directory supplied. */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [directory] = process.argv.slice(2);
if (!directory) throw new Error("Usage: node run-workspace.mjs OUTPUT_DIRECTORY");
const output = resolve(directory);
mkdirSync(output, { recursive: true });
const env = Object.fromEntries(["HOME", "PATH", "TMPDIR", "SystemRoot", "ComSpec", "COREPACK_HOME"]
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { CI: "true", TZ: "UTC", NO_COLOR: "1", NO_UPDATE_NOTIFIER: "1", ALTER_BROWSER: "off" });
const runs = [
  ["tests", ["test"]],
  ["typecheck", ["typecheck"]],
  ["web-build", ["--filter", "@alter/web", "build"]],
];
function run(program, args) {
  return spawnSync(program, args, { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
const version = (program, args) => run(program, args).stdout.trim();
const summary = {
  revision: version("git", ["rev-parse", "HEAD"]),
  node: process.version, pnpm: version("pnpm", ["--version"]), platform: process.platform, arch: process.arch,
  scheduling: "pnpm and Vitest workspace defaults", runs: [],
};
for (const [name, args] of runs) {
  const result = run("pnpm", args);
  writeFileSync(join(output, name + ".log"), (result.stdout ?? "") + (result.stderr ?? "") + (result.error?.message ?? ""));
  summary.runs.push({ name, command: ["pnpm", ...args], exit: result.status, signal: result.signal });
  writeFileSync(join(output, "workspace.json"), JSON.stringify(summary, null, 2) + "\n");
  if (result.status !== 0) process.exitCode = 1;
}
