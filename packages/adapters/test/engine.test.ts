import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { definition, openAdapterEngine, openSecrets, presetConfig } from "../src/index.ts";

it("validates credential templates and keeps GitHub preset tokens separate from transport settings", () => {
  expect(() => definition("mcp", { transport: "http", url: "https://example.org", headers: { authorization: "literal" } })).toThrow(/placeholder/);
  const p = presetConfig("github", { auth: "token", token: "private-value" });
  expect(JSON.stringify(p.config)).not.toContain("private-value");
  expect(p.config.headers.Authorization).toBe("Bearer {{secret:GITHUB_TOKEN}}");
  expect(() => presetConfig("github", { auth: "gh", token: "unused" })).toThrow();
});

it("shares discovery, effect overrides, atomic configuration and secret redaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-"));
  const engine = openAdapterEngine(dir, openSecrets(dir), { redactOutput: true });
  const create = { id: "echo", kind: "cli", name: "Echo", config: { command: process.execPath, help: "echo", args: ["-p", "process.env.TOKEN"],
    env: { TOKEN: "{{secret:TOKEN}}" } }, secrets: { TOKEN: "an-opaque-value" } };
  try {
    await expect(engine.create({ ...create, name: "prefix-abc", secrets: { TOKEN: "abc" } })).rejects.toThrow(/placeholder/);
    const results = await Promise.allSettled([engine.create(create), engine.create(create)]);
    expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(engine.list()[0]?.tools[0]?.effect).toBe("write");
    expect(await engine.patch("echo", { effects: { run: "read" } })).toMatchObject({ tools: [{ effect: "read", defaultEffect: "write" }] });
    const result = await engine.call("echo", "run", { args: [] });
    expect(JSON.stringify(result)).toContain("[redacted]");
    for (const text of [JSON.stringify(result), readFileSync(join(dir, "adapters.json"), "utf8"), readFileSync(join(dir, "secrets.json"), "utf8")])
      expect(text).not.toContain(create.secrets.TOKEN);
    await engine.patch("echo", { enabled: false });
    expect(() => engine.call("echo", "run", {})).toThrow(/unavailable/);
  } finally { await engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("withholds custom credential headers from a different origin advertised by an OpenAPI document", async () => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const secret = "fixture-access-key";
  const requests: unknown[] = [];
  const api = createServer((req, res) => { requests.push(req.headers["x-access-key"]); res.end("ok"); });
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  const base = "http://127.0.0.1:" + (api.address() as import("node:net").AddressInfo).port;
  const spec = createServer((req, res) => {
    requests.push(req.headers["x-access-key"]);
    res.end(JSON.stringify({ openapi: "3.1.0", servers: [{ url: base }], paths: { "/": { get: { operationId: "get" } } } }));
  });
  spec.listen(0, "127.0.0.1"); await once(spec, "listening");
  const url = "http://127.0.0.1:" + (spec.address() as import("node:net").AddressInfo).port;
  try {
    const { discoverHttp } = await import("../src/http.ts");
    const signal = AbortSignal.timeout(2000);
    const conn = await discoverHttp({ spec: url, headers: { "X-Access-Key": "{{secret:KEY}}" } },
      async s => s.replace("{{secret:KEY}}", secret), signal);
    expect((await conn.tools[0]!.call({}, signal)).isError).toBe(false);
    expect(requests).toEqual([secret, undefined]);
  } finally { await Promise.all([api[Symbol.asyncDispose](), spec[Symbol.asyncDispose]()]); }
});
