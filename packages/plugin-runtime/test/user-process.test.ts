import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openRuntime } from "../src/index.ts";
import { fixture, manifest } from "./fixtures.ts";

it("runs commands, uses the filesystem and fetches directly with only the allowed environment", async () => {
  const { data, pkg, write } = fixture();
  const { network: _network, ...declaration } = manifest;
  write({ ...declaration, secrets: [{ name: "lang", purpose: "test name collision" }] });
  const marker = join(data, "result.txt");
  writeFileSync(join(pkg, "index.mjs"), `
    import { execFileSync } from "node:child_process";
    import { writeFileSync } from "node:fs";
    export default { tools: { async read({url, marker}) {
      const echo = process.platform === "win32"
        ? execFileSync(process.execPath, ["-p", "'echo ok'"], {encoding:"utf8"})
        : execFileSync("/bin/echo", ["echo ok"], {encoding:"utf8"});
      const body = await (await fetch(url)).text();
      writeFileSync(marker, body);
      return {echo:echo.trim(), path:process.env.PATH, keys:Object.keys(process.env)};
    } } };
  `);
  const server = createServer((_, res) => res.end("local fixture"));
  const runtime = openRuntime(data, { notify: async () => {}, emit: async () => {}, changed() {},
    secrets: () => ({ lang: "declared-test-credential" }) });
  vi.stubEnv("ALTER_TEST_SECRET", "host-only-test-value");
  vi.stubEnv("LANG", "en_US.UTF-8");
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP port");
    const { sha } = await runtime.store.propose(pkg);
    await runtime.store.approve("sample", sha);
    const result = await runtime.invoke("sample", sha, { kind: "tools", name: "read",
      args: { url: "http://127.0.0.1:" + address.port, marker } });
    expect(result).toMatchObject({ echo: "echo ok", path: process.env.PATH });
    expect(result).toHaveProperty("keys");
    const { keys } = result as { keys: string[] };
    expect(keys.map(k => k.toUpperCase())).not.toContain("ALTER_TEST_SECRET");
    expect(keys.map(k => k.toUpperCase())).not.toContain("LANG");
    expect(readFileSync(marker, "utf8")).toBe("local fixture");
  } finally {
    vi.unstubAllEnvs();
    server.closeAllConnections(); server.close();
    await runtime.close();
  }
});
