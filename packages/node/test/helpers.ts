import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { Detected } from "../src/spawn.ts";

export const script = fileURLToPath(new URL("./fixtures/harness.mjs", import.meta.url));
export function workspace() {
  const base = mkdtempSync(path.join(tmpdir(), "alter-node-test-"));
  const root = path.join(base, "工作 目录"), bin = path.join(base, "bin"), dir = path.join(base, "config");
  mkdirSync(root); mkdirSync(bin);
  const harnesses: Detected[] = [];
  for (const name of ["claude", "codex", "opencode"] as const) {
    const win = process.platform === "win32";
    const executable = path.join(bin, name + (win ? ".cmd" : ""));
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    writeFileSync(executable, win ? '@echo off\r\n"' + process.execPath + '" "' + script + '" ' + name + ' %*\r\n'
      : "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(script) + " " + name + ' "$@"\n');
    chmodSync(executable, 0o700);
    harnesses.push({ id: name === "claude" ? "claude-code" : name, executable, available: name !== "opencode" });
  }
  return { base, root, bin, dir, harnesses };
}
export async function until<T>(fn: () => T | undefined) {
  let value: T | undefined;
  await expect.poll(() => { value = fn(); return value !== undefined; }, { timeout: 5000, interval: 15 }).toBe(true);
  return value!;
}
