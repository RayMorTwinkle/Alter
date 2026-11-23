import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createProxy, NetworkViolation, publicAddress, type HttpAudit } from "../src/http.ts";
import { manifest } from "./fixtures.ts";

const context = { effect: "read" as const, tainted: async () => false, secrets: { token: "fixture_credential" }, signal: new AbortController().signal };
const logs: HttpAudit[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { while (stops.length) await stops.pop()!(); logs.length = 0; });
async function local(handler: RequestListener, timeoutMs = 1000) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  stops.push(async () => { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; });
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/';
  const proxy = createProxy(e => logs.push(e), { testLoopback: true, timeoutMs });
  const m = { ...manifest, network: [...manifest.network, ...["127.0.0.1", "10.1.2.3"].map(host => ({ host, methods: ["GET"], pathPrefixes: ["/"] }))] };
  return { url, request: (extra = {}) => proxy(m, { method: "GET", url, ...extra }, context) };
}
it("checks every DNS answer, host, scheme, credentials, port, path, read method and query before connecting", async () => {
  const proxy = createProxy(e => logs.push(e), { resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.1.1.1", family: 4 }] });
  const m = { ...manifest, network: [{ host: "example.com", methods: ["GET", "POST"], pathPrefixes: ["/feed"] }] };
  for (const [url, method, body] of [
    ["https://example.com/feed", "GET"], ["https://other.com/feed", "GET"], ["http://example.com/feed", "GET"],
    ["https://user@example.com/feed", "GET"], ["https://example.com:8443/feed", "GET"], ["https://example.com/admin", "GET"],
    ["https://example.com/feed", "POST"], ["https://example.com/feed", "GET", ""], ["https://example.com/feed?q=fixture%5Fcredential", "GET"],
  ]) await expect(proxy(m, { url, method, body }, context)).rejects.toBeInstanceOf(NetworkViolation);
  await expect(proxy(m, { method: "GET", url: "https://example.com/feed?q=test" }, { ...context, tainted: async () => true })).rejects.toThrow("Tainted");
  expect(logs.map(l => l.decision)).toEqual(Array(10).fill("deny"));
  expect(JSON.stringify(logs)).not.toContain(context.secrets.token);
});
it.each(["https://10.1.2.3/", "https://127.0.0.1/"])("validates the redirect target %s", async target => {
  const { request } = await local((_, res) => res.writeHead(302, { Location: target }).end());
  await expect(request()).rejects.toThrow("Forbidden address");
  expect(logs.map(l => l.decision)).toEqual(["allow", "deny"]);
});
it("substitutes credentials only at the destination and withholds reflections", async () => {
  let seen: string | undefined;
  const { request } = await local((req, res) => { seen = req.headers.authorization; res.end(seen); });
  await expect(request({ secretHeaders: { Authorization: "Bearer ${secret:token}" } })).rejects.toThrow("credential");
  expect(seen).toBe("Bearer " + context.secrets.token);
  expect(JSON.stringify(logs)).not.toContain(context.secrets.token);
});
it("limits streaming responses and audits the decision", async () => {
  const { request } = await local((_, res) => { res.write(Buffer.alloc(2 * 1024 * 1024)); res.end("x"); });
  await expect(request()).rejects.toThrow("2 MiB"); expect(logs.at(-1)?.decision).toBe("error");
});
it("times out the entire request including DNS", async () => {
  const { request } = await local(() => {}, 30);
  await expect(request()).rejects.toThrow("timeout");
  const proxy = createProxy(e => logs.push(e), { timeoutMs: 20, resolve: () => new Promise(() => {}) });
  await expect(proxy(manifest, { method: "GET", url: "https://example.com/" }, context)).rejects.toThrow("timeout");
  expect(logs.filter(l => l.reason === "HTTP timeout")).toHaveLength(2);
});
it("rejects reserved and translated addresses", () => {
  for (const ip of ["198.51.100.2", "169.254.169.254", "224.1.2.3", "fc00::1", "::1", "::ffff:8.8.8.8", "64:ff9b::7f00:1", "2002::7f00:1", "fe80::1", "2001:db8::a"]) expect(publicAddress(ip)).toBe(false);
  expect(publicAddress("2606:4700:4700::1111")).toBe(true);
});

it("pins the vetted IP on each TLS hop, retains the URL host and strips credentials across origins", async () => {
  const https = (await import("node:https")).default;
  const http = (await import("node:http")).default;
  const { vi } = await import("vitest");
  const calls: (string | undefined)[] = [], hosts: string[] = [];
  const fixture = await local((req, res) => {
    calls.push(req.headers.authorization);
    if (calls.length === 1) res.writeHead(302, { Location: "https://second.example/path" });
    res.end("ok");
  });
  const request = vi.spyOn(https, "request").mockImplementation((url, options, callback) => {
    if (!(url instanceof URL) || !options || typeof options !== "object" || !callback) throw new Error("Invalid TLS request");
    hosts.push(url.hostname);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.agent).toBe(false);
    expect(options.headers).not.toHaveProperty("host");
    options.lookup!(url.hostname, { family: 4 }, (err, address) => {
      expect(err).toBeNull(); expect(address).toBe("93.184.216.34");
    });
    return http.request(fixture.url, { headers: options.headers }, callback);
  });
  try {
    const resolve = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const proxy = createProxy(e => logs.push(e), { resolve });
    const m = { ...manifest, network: [...manifest.network, { host: "second.example", methods: ["GET"], pathPrefixes: ["/path"] }] };
    await expect(proxy(m, { method: "GET", url: "https://example.com/", secretHeaders: { Authorization: "Bearer ${secret:token}" } }, context))
      .resolves.toEqual({ body: "ok", status: 200 });
    expect(hosts).toEqual(["example.com","second.example"]);
    expect(resolve.mock.calls).toEqual([["example.com"],["second.example"]]);
    expect(calls).toEqual(["Bearer " + context.secrets.token, undefined]);
    expect(logs.map(l => l.decision)).toEqual(["allow","allow"]);
  } finally { request.mockRestore(); }
});
