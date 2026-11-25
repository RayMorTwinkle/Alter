#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { configDir, directory, inside, loadConfig, lock, pair, saveConfig } from "./config.ts";
import { detectHarnesses } from "./spawn.ts";

const help = `alter-node pair --server <url> --token <token> [--name <名称>] [--root <目录> ...]
alter-node run
alter-node status
alter-node roots list | add <目录> | remove <目录>
alter-node install-service | uninstall-service`;

async function main([cmd, ...args]: string[]) {
  const dir = configDir();
  if (!cmd || cmd === "--help") { console.log(help); return; }
  if (cmd === "pair") {
    // Accept both repeated --root and several consecutive values after --root.
    const flags: string[] = [];
    for (let i = 0; i < args.length; i++) {
      flags.push(args[i]!);
      if (args[i] !== "--root") continue;
      if (!args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error("--root 需要目录");
      flags.push(args[++i]!);
      while (args[i + 1] && !args[i + 1]!.startsWith("--")) flags.push("--root", args[++i]!);
    }
    let v;
    try { v = parseArgs({ args: flags, options: { server: { type: "string" }, token: { type: "string" },
      name: { type: "string" }, root: { type: "string", multiple: true } } }).values; }
    catch { throw new Error("配对参数无效，参见 --help"); }
    if (!v.server || !v.token) throw new Error("需要 --server 和 --token");
    const c = pair(dir, v.server, v.token, v.name, v.root);
    console.log("已保存配对配置", c.name, c.nodeId); return;
  }
  if (cmd === "roots") {
    const [op, arg] = args;
    const release = lock(dir, "config");
    try {
      const c = loadConfig(dir);
      if (op === "list" && args.length === 1) { console.log(c.roots.join("\n")); return; }
      if (args.length !== 2 || !arg || (op !== "add" && op !== "remove")) throw new Error(help);
      const root = op === "add" ? directory(arg) : path.resolve(arg);
      const paths = [root];
      if (op === "remove" && existsSync(root)) paths.push(realpathSync.native(root));
      const same = (r: string) => paths.some(p => inside(p, r) && inside(r, p));
      if (op === "remove") c.roots = c.roots.filter(r => !same(r));
      else if (!c.roots.some(same)) c.roots.push(root);
      saveConfig(dir, c);
    } finally { release(); }
    return;
  }
  if (args.length) throw new Error(help);
  if (cmd === "install-service" || cmd === "uninstall-service") {
    const { configureService } = await import("./service.ts");
    configureService(cmd === "install-service");
    console.log(cmd === "install-service" ? "已设置登录自启" : "已移除登录自启");
    return;
  }
  const c = loadConfig(dir);
  if (cmd === "status") {
    let state = "已停止";
    try { lock(dir, "run")(); } catch {
      const file = path.join(dir, "status.json");
      state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).state : "正在启动";
    }
    console.log(JSON.stringify({ nodeId: c.nodeId, name: c.name, server: c.server, roots: c.roots, state }, null, 2)); return;
  }
  if (cmd !== "run") throw new Error(help);
  const { runNode } = await import("./connection.ts");
  const controller = new AbortController();
  let runtime: ReturnType<typeof runNode> | undefined;
  const stop = () => { controller.abort(); void runtime?.stop().catch(() => {}); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const harnesses = await detectHarnesses(process.env, controller.signal);
    if (controller.signal.aborted) return;
    runtime = runNode(dir, harnesses);
    await runtime.done;
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

main(process.argv.slice(2)).catch(err => {
  console.error(err instanceof SyntaxError ? "配置文件格式无效" : err instanceof Error ? err.message : "节点运行失败");
  process.exitCode = 1;
});
