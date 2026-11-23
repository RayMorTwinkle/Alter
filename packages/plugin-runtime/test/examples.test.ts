import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { inspect } from "../src/packages.ts";
import { run, type HostCall } from "../src/process.ts";
import { fixture, manifest } from "./fixtures.ts";

it.each([
  ["rss", "<rss><channel><item><guid>one</guid><title>Story</title></item></channel></rss>", "one"],
  ["json", JSON.stringify({ hits: [{ objectID: "two", title: "Story", url: "https://example.com/2" }] }), "two"],
  ["github", JSON.stringify([{ id: "three", repository: { full_name: "org/repo" }, subject: { type: "Issue", title: "Story", url: "https://api.github.com/repos/org/repo/issues/2" } }]), "three"],
])("runs the %s example through bounded stdio RPC with offline HTTP", async (id, body, item) => {
  const dir = fileURLToPath(new URL("../examples/" + id, import.meta.url));
  const { manifest } = inspect(dir);
  const token = "fixture-secret";
  const host: HostCall = async (method, input) => {
    expect(method).toBe("http.request"); expect(JSON.stringify(input)).not.toContain(token);
    if (id === "github") expect(input).toMatchObject({ secretHeaders: { Authorization: "Bearer ${secret:token}" } });
    return { body, status: 200 };
  };
  await expect(run(dir, manifest.resources, { kind: "sources", name: id!, args: null }, host, new AbortController().signal, [token]))
    .resolves.toMatchObject([{ id: item, title: "Story" }]);
});

it("withholds raw secrets from every host frame and supports concurrent SDK calls", async () => {
  const {pkg} = fixture(), token = "fixture-credential";
  writeFileSync(join(pkg,"index.mjs"), `
    export default {tools:{async probe(args,ctx) {
      const lines = [];
      process.stdin.on("data", chunk => lines.push(String(chunk)));
      const results = await Promise.allSettled([ctx.kv.get("secret"),ctx.borrow("notes_read",{})]);
      return {lines,states:results.map(r => r.status)};
    }}};
  `);
  const invoke = (args: unknown) => run(pkg,manifest.resources,{kind:"tools",name:"probe",args},
    async () => ({value:token}),new AbortController().signal,[token]);
  expect(() => invoke({x:token})).toThrow("Credential withheld");
  const result = await invoke({});
  expect(result).toMatchObject({states:["rejected","rejected"]});
  expect(JSON.stringify(result)).not.toContain(token);
  expect(JSON.stringify(result)).toContain("Host request refused");
});

it("terminates a stalled worker on timeout and measures RSS while the plugin event loop is blocked", async () => {
  const { pkg } = fixture();
  writeFileSync(join(pkg, "index.mjs"), `
    export default {tools:{
      wait: () => new Promise(() => {}),
      allocate: () => { globalThis.hold = Buffer.alloc(96 * 1024 * 1024, 1); for (;;) {} }
    }}`);
  const invoke = (name: string, timeoutMs: number) => run(pkg, { ...manifest.resources, memoryMB: 96, timeoutMs },
    { kind: "tools", name, args: {} }, async () => null, new AbortController().signal, []);
  await expect(invoke("wait", 150)).rejects.toThrow("timeout");
  await expect(invoke("allocate", 3500)).rejects.toThrow("memory limit");
});
