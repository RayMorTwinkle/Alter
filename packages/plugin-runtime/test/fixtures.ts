import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { Manifest } from "../src/manifest.ts";

export const manifest: Manifest & Required<Pick<Manifest, "network">> = { schemaVersion: 1, id: "sample", version: "1", displayName: "Sample", description: "Fixture",
  tools: [{ name: "read", description: "test", effect: "read", inputSchema: { type: "object" } }],
  sources: [{ name: "feed", minIntervalSeconds: 60 }], network: [{ host: "example.com", methods: ["GET"], pathPrefixes: ["/"] }],
  secrets: [{ name: "token", purpose: "Fixture" }], borrows: ["notes_read"], resources: { memoryMB: 128, timeoutMs: 5000, storageKB: 2 }};
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
export function fixture() {
  const data = mkdtempSync(join(tmpdir(), "alter86-")), pkg = join(data, "fixture");
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  mkdirSync(pkg);
  const write = (m: Manifest) => writeFileSync(join(pkg, "alter-plugin.json"), JSON.stringify(m));
  write(manifest);
  writeFileSync(join(pkg, "index.mjs"), "export default {}");
  return { data, pkg, write };
}

export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
