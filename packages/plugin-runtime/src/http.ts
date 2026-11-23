import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { check, record, type Effect, type Manifest } from "./manifest.ts";

const blocked = new BlockList();
for (const [ip, bits] of Object.entries({
  "0.0.0.0": 8, "10.0.0.0": 8, "100.64.0.0": 10, "127.0.0.0": 8, "169.254.0.0": 16, "172.16.0.0": 12,
  "192.0.0.0": 24, "192.0.2.0": 24, "192.31.196.0": 24, "192.52.193.0": 24, "192.88.99.0": 24,
  "192.168.0.0": 16, "192.175.48.0": 24, "198.18.0.0": 15, "198.51.100.0": 24, "203.0.113.0": 24, "224.0.0.0": 3,
  "168.63.129.16": 32,
})) blocked.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of Object.entries({ "2001::": 23, "2001:db8::": 32, "2002::": 16, "2620:4f:8000::": 48, "3fff::": 20 }))
  blocked.addSubnet(ip, bits, "ipv6");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
export function publicAddress(ip: string) {
  return isIP(ip) === 4 ? !blocked.check(ip, "ipv4") :
    isIP(ip) === 6 && global6.check(ip, "ipv6") && !blocked.check(ip, "ipv6");
}
export class NetworkViolation extends Error {}
function permit(ok: unknown, message: string): asserts ok { if (!ok) throw new NetworkViolation(message); }
export type HttpAudit = { plugin: string; method: string; host?: string; decision: "allow" | "deny" | "error"; reason?: string };
type Options = { resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  testLoopback?: boolean; timeoutMs?: number };
type Context = { effect: Effect; tainted: () => Promise<boolean>; secrets: Record<string, string>; signal: AbortSignal };
type Response = { status: number; body: string; location?: string };
const maxResponse = 2 * 1024 * 1024;
function send(url: URL, method: string, address: string, headers: Record<string, string>, body: string | undefined, signal: AbortSignal) {
  return new Promise<Response>((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(url, { method, headers, agent: false, signal, family: isIP(address),
      rejectUnauthorized: true, lookup: (_host, _options, cb) => cb(null, address, isIP(address)),
    }, res => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const fail = () => { res.destroy(); reject(new Error("Response exceeds 2 MiB")); };
      if (Number(res.headers["content-length"]) > maxResponse) return fail();
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxResponse) fail(); else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), location: res.headers.location }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
function headers(map: unknown, m: Manifest, secrets?: Record<string, string>) {
  const result: Record<string, string> = Object.create(null);
  if (map === undefined) return result;
  permit(record(map) && Object.keys(map).length <= 32, "Invalid headers");
  for (const [name, v] of Object.entries(map)) {
    permit(/^[A-Za-z][\w-]*$/.test(name) && !/^(?:host|connection|upgrade|transfer-encoding|content-length|expect|trailer|te|forwarded|via|proxy-.*|x-(?:forwarded|original|rewrite|http-method).*)$/i.test(name), "Forbidden header");
    permit(typeof v === "string" && /^[\x20-\x7e]*$/.test(v) && v.length <= 8192, "Invalid header value");
    result[name.toLowerCase()] = secrets ? v.replace(/\$\{secret:([^}]+)\}/g, (_, k: string) => {
      permit(m.secrets.some(s => s.name === k), "Undeclared secret");
      check(Object.hasOwn(secrets, k), "Secret is not configured");
      return secrets[k]!;
    }) : v;
    permit(result[name.toLowerCase()]!.length <= 8192, "Header too large");
  }
  return result;
}
export function createProxy(audit: (e: HttpAudit) => void, options: Options = {}) {
  const rates = new Map<string, number[]>();
  const resolve = options.resolve ?? (host => lookup(host, { all: true, verbatim: true }));
  return async (m: Manifest, input: unknown, ctx: Context) => {
    let method = "INVALID", host: string | undefined;
    const log = (decision: HttpAudit["decision"], reason?: string) => audit({ plugin: m.id, method, host, decision, reason });
    const deadline = AbortSignal.timeout(options.timeoutMs ?? 15_000);
    const signal = AbortSignal.any([deadline, ctx.signal]);
    let aborted!: () => void;
    const timeout = new Promise<never>((_, reject) => {
      aborted = () => reject(new Error("HTTP request interrupted"));
      signal.addEventListener("abort", aborted, { once: true });
    });
    try {
      permit(record(input) && Object.keys(input).every(k => ["url", "method", "headers", "body", "secretHeaders"].includes(k)), "Invalid HTTP request");
      permit(typeof input.url === "string" && URL.canParse(input.url), "Invalid URL");
      permit(typeof input.method === "string" && /^[A-Z]{1,8}$/.test(input.method), "Invalid method");
      method = input.method;
      const body = input.body;
      permit(body === undefined || typeof body === "string" && Buffer.byteLength(body) <= 256 * 1024, "Invalid or oversized body");
      const read = ctx.effect === "read" || ctx.effect === "write-local";
      permit(!read || (["GET", "HEAD"].includes(method) && body === undefined), "Read request requires GET/HEAD without a body");
      const ordinary = headers(input.headers, m), secret = headers(input.secretHeaders, m, ctx.secrets);
      let outgoing = { ...ordinary, ...secret };
      let url = new URL(input.url);
      for (let hop = 0;;hop++) {
        signal.throwIfAborted();
        host = url.hostname;
        const local = options.testLoopback && hop === 0 && host === "127.0.0.1" && url.protocol === "http:";
        permit(!url.username && !url.password && !url.hash && (local || url.protocol === "https:" && !url.port), "Forbidden URL");
        permit(!/%(?:2[ef]|5c|25|00|3f|23)/i.test(url.pathname) && !url.pathname.includes("//"), "Ambiguous path");
        permit(m.network.some(r => r.host === host && r.methods.includes(method) && r.pathPrefixes.some(p => url.pathname.startsWith(p))), "Undeclared destination");
        if (url.search) {
          const query = [...url.searchParams].flat().join("\n");
          permit(!Object.values(ctx.secrets).some(v => v && (query.includes(v) || url.search.includes(v))), "Secret in query");
          if (read) permit(!await Promise.race([ctx.tainted(), timeout]), "Tainted query");
        }
        const now = Date.now();
        const recent = (rates.get(m.id) ?? []).filter(t => t > now - 60_000);
        check(recent.length < 60, "HTTP rate limit exceeded");
        recent.push(now); rates.set(m.id, recent);
        const literal = host.replace(/^\[|\]$/g, "");
        const addresses = isIP(literal) ? [{ address: literal, family: isIP(literal) }] : await Promise.race([resolve(host), timeout]);
        permit(addresses.length && addresses.every(a => isIP(a.address) === a.family && (local || publicAddress(a.address))), "Forbidden address");
        signal.throwIfAborted();
        log("allow");
        const res = await Promise.race([send(url, method, addresses[0]!.address, outgoing, body, signal), timeout]);
        if (![301, 302, 303, 307, 308].includes(res.status) || !res.location) {
          check(!Object.values(ctx.secrets).some(s => s && res.body.includes(s)), "Response contained a credential");
          return { status: res.status, body: res.body };
        }
        permit(hop < 3 && URL.canParse(res.location, url), "Invalid redirect or redirect limit");
        const next = new URL(res.location, url);
        permit(!Object.values(ctx.secrets).some(s => s && (next.href.includes(s) ||
          decodeURIComponent(next.pathname).includes(s))), "Credential in redirect");
        if (next.origin !== url.origin) {
          permit(body === undefined, "Cross-origin body redirect");
          outgoing = {};
        }
        url = next;
      }
    } catch (e) {
      const reason = e instanceof NetworkViolation ? e.message : deadline.aborted ? "HTTP timeout" :
        e instanceof Error && ["Response exceeds 2 MiB", "HTTP rate limit exceeded", "Response contained a credential", "Secret is not configured"].includes(e.message) ? e.message : "HTTP request failed";
      log(e instanceof NetworkViolation ? "deny" : "error", reason);
      if (e instanceof NetworkViolation) throw e;
      throw new Error(reason);
    } finally { signal.removeEventListener("abort", aborted); }
  };
}
