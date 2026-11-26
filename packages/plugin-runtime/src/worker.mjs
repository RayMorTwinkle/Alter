import { AsyncLocalStorage } from "node:async_hooks";
import { createInterface } from "node:readline";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

// Sample process-wide RSS even when the plugin blocks its own event loop.
const monitor = new Worker(`
  const { workerData } = require("node:worker_threads");
  const { writeSync } = require("node:fs");
  setInterval(() => {
    if (process.memoryUsage.rss() > workerData) {
      writeSync(2, "ALTER_PLUGIN_RSS_LIMIT\\n");
      process.kill(process.pid, "SIGKILL");
    }
  }, 100);
`, { eval: true, execArgv: [], workerData: Number(process.argv[2]) * 1024 * 1024 });
monitor.unref();
const sdk = process.argv[1];
registerHooks({
  resolve(name, context, next) {
    if (name === "@alter/plugin-sdk") return { url: sdk, shortCircuit: true };
    return next(name, context);
  }
});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const current = new AsyncLocalStorage();
const calls = new Map();
let loading, closing = false;
function write(value) {
  const line = JSON.stringify({ jsonrpc: "2.0", ...value });
  if (Buffer.byteLength(line) > 4194304) throw new Error("Frame too large");
  process.stdout.write(line + "\n");
}
function rpc(method, params) {
  const call = current.getStore();
  if (!call || call.cancelled || !calls.has(call.callId)) return Promise.reject(new Error("Invocation stopped"));
  const work = call.queue.then(() => new Promise((resolve, reject) => {
    if (call.cancelled) return reject(new Error("Invocation stopped"));
    call.waiter = { resolve, reject };
    write({ callId: call.callId, id: ++call.seq, method, params });
  }));
  call.queue = work.catch(() => {});
  return work;
}
const ctx = {
  secrets: { get: async name => (await rpc("secrets.get", { name })) ?? undefined, list: () => rpc("secrets.list", {}) },
  http: { request: request => rpc("http.request", request) },
  kv: {
    get: key => rpc("kv.get", { key }), set: (key, value) => rpc("kv.set", { key, value }),
    delete: key => rpc("kv.delete", { key }), list: () => rpc("kv.list", {})
  },
  borrow: (tool, args) => rpc("borrow", { tool, args }), log: message => rpc("log", { message }),
};
function cancel(call) {
  call.cancelled = true;
  call.waiter?.reject(new Error("Invocation stopped"));
}
async function close() {
  if (closing) return;
  closing = true;
  for (const call of calls.values()) cancel(call);
  // EOF also stops long-lived plugins if the parent disappears.
  setTimeout(() => process.exit(1), 500).unref();
  try { await (await loading)?.close?.(); }
  finally { process.exit(0); }
}
lines.once("close", close);
lines.on("line", async line => {
  const msg = JSON.parse(line);
  if (closing) return;
  if (msg.method === "close") return close();
  if (msg.method === "invoke") {
    const call = { callId: msg.callId, seq: 0, queue: Promise.resolve(), cancelled: false };
    calls.set(msg.callId, call);
    await current.run(call, async () => {
      try {
        loading ??= import(pathToFileURL(process.cwd() + "/index.mjs")).then(async ({ default: plugin }) => {
          await plugin.init?.(ctx);
          return plugin;
        }).catch(() => process.exit(1));
        const plugin = await loading;
        if (closing || call.cancelled) throw new Error();
        const { kind, name, args } = msg.params;
        if (!Object.hasOwn(plugin[kind], name)) throw new Error();
        const result = kind === "tools" ? await plugin.tools[name](args, ctx) : await plugin.sources[name](ctx);
        await call.queue;
        write({ callId: msg.callId, result: result ?? null });
      } catch {
        await call.queue;
        write({ callId: msg.callId, error: { code: -32000, message: "Plugin invocation failed" } });
      } finally { calls.delete(msg.callId); }
    });
  } else {
    const call = calls.get(msg.callId);
    if (!call) return;
    if (msg.method === "cancel") cancel(call);
    else if (msg.id === call.seq && call.waiter) {
      if (msg.error) call.waiter.reject(new Error(msg.error.message));
      else call.waiter.resolve(msg.result);
      call.waiter = undefined;
    }
  }
});
