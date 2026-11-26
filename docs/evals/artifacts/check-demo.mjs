// Same command and restrictions for every revision. On macOS the OS denies networking.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [directory] = process.argv.slice(2);
if (!directory) throw new Error("Usage: node check-demo.mjs OUTPUT_DIRECTORY");
const output = resolve(directory);
mkdirSync(output, { recursive: true });
const env = Object.fromEntries(["HOME", "PATH", "TMPDIR", "COREPACK_HOME", "SystemRoot", "ComSpec"]
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { TZ: "UTC", CI: "true", COREPACK_ENABLE_NETWORK: "0", NO_COLOR: "1" });
const denied = process.platform === "darwin";
const command = [...(denied ? ["sandbox-exec", "-p", "(version 1) (allow default) (deny network*)"] : []), "pnpm", "demo"];
const runs = [];
for (let iteration = 1; iteration <= 3; iteration++) {
  const result = spawnSync(command[0], command.slice(1), { env, encoding: "utf8", timeout: 30_000 });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  writeFileSync(join(output, "demo-" + iteration + ".log"), stdout + stderr + (result.error?.message ?? ""));
  runs.push({ exit: result.status, stdout, signal: result.signal });
}
const success = runs.every(run => run.exit === 0);
const sameOutput = runs.every(run => run.stdout === runs[0].stdout);
const revision = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
writeFileSync(join(output, "demo.json"), JSON.stringify({
  revision, node: process.version, command, osNetworkDenied: denied,
  exits: runs.map(run => run.exit), identicalStdout: sameOutput,
}, null, 2) + "\n");
if (!success || !sameOutput) process.exitCode = 1;
