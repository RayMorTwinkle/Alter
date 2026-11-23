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
const pending = new Map();
let seq = 0, queue = Promise.resolve();
function write(value) {
  const line = JSON.stringify({ jsonrpc: "2.0", ...value });
  if (Buffer.byteLength(line) > 4194304) throw new Error("Frame too large");
  process.stdout.write(line + "\n");
}
function rpc(method, params) {
  const work = queue.then(() => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    write({ id, method, params });
  }));
  queue = work.catch(() => {});
  return work;
}
const ctx = {
  http: { request: request => rpc("http.request", request) },
  kv: {
    get: key => rpc("kv.get", { key }), set: (key, value) => rpc("kv.set", { key, value }),
    delete: key => rpc("kv.delete", { key }), list: () => rpc("kv.list", {})
  },
  borrow: (tool, args) => rpc("borrow", { tool, args }), log: message => rpc("log", { message }),
};
lines.on("line", async line => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === "invoke") {
      const { kind, name, args } = msg.params;
      const plugin = (await import(pathToFileURL(process.cwd() + "/index.mjs"))).default;
      if (!Object.hasOwn(plugin[kind], name)) throw new Error();
      const result = kind === "tools" ? await plugin.tools[name](args, ctx) : await plugin.sources[name](ctx);
      await queue;
      write({ id: msg.id, result: result ?? null });
    } else {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    }
  } catch {
    write({ id: "invoke", error: { code: -32000, message: "Plugin invocation failed" } });
  }
});
