import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { adapterPresets, record } from "@alter/adapters";
import type { AdapterManagement, AdapterManagementResult } from "@alter/node-protocol";
import { atomicWrite, lock } from "./config.ts";
import { nodeAdapters } from "./node-adapters.ts";


type Runtime = ReturnType<typeof nodeAdapters>;
type Command = AdapterManagement | { action: "effect"; adapterId: string; tool: string; effect: string };
async function execute(runtime: Runtime, command: Command) {
  if (command.action !== "effect") return runtime.manage(command);
  return runtime.setEffect(command.adapterId, command.tool, command.effect);
}

// A single writer owns both adapter files. CLI processes use a private, per-run OS
// socket while the daemon holds run.lock. Short temp paths fit macOS sockaddr_un.
export async function serveAdapterCli(dir: string, runtime: Runtime) {
  const token = randomUUID();
  const temp = process.platform === "win32" ? undefined : mkdtempSync(join(tmpdir(), "an-"));
  const socketPath = temp ? join(temp, "s") : "\\\\.\\pipe\\alter-node-" + randomUUID();
  const file = join(dir, "adapter-control.json");
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.headers.authorization !== "Bearer " + token) { res.writeHead(403).end(); return; }
    try {
      let body = "";
      req.setEncoding("utf8");
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024 * 1024) throw new Error("Request too large");
      }
      const data = await execute(runtime, JSON.parse(body));
      res.end(JSON.stringify({ ok: true, data }));
    } catch (error) {
      res.end(JSON.stringify({ ok: false, error: error instanceof SyntaxError ? "Invalid JSON" : error instanceof Error ? error.message : "Command failed" }));
    }
  });
  function close() {
    server.close(); server.closeAllConnections();
    rmSync(file, { force: true });
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    atomicWrite(file, JSON.stringify({ socketPath, token }), true);
    return close;
  } catch (error) { close(); throw error; }
}

async function liveCommand(dir: string, command: Command) {
  const { socketPath, token } = JSON.parse(readFileSync(join(dir, "adapter-control.json"), "utf8"));
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = request({ socketPath, method: "POST", headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(610_000) }, resolve);
    req.once("error", reject);
    req.end(JSON.stringify(command));
  });
  let text = "";
  for await (const chunk of response.setEncoding("utf8")) text += chunk;
  const result: Pick<AdapterManagementResult, "data" | "ok" | "error"> = JSON.parse(text);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

export async function adapterCli(args: string[], defaultDir: string) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    dir: { type: "string" }, file: { type: "string" }, preset: { type: "string" },
  } });
  const dir = values.dir ?? defaultDir;
  const [op, adapterId, tool, effect] = positionals;
  let command: Command;
  if (op === "add" && positionals.length === 1) {
    const payload: unknown = JSON.parse(readFileSync(values.file && values.file !== "-" ? values.file : 0, "utf8"));
    if (!record(payload)) throw new Error("Expected a JSON object");
    command = { action: values.preset ? "preset.create" : "create", presetId: values.preset, payload };
  } else if (op === "presets" && positionals.length === 1) return adapterPresets;
  else if (op === "list" && positionals.length === 1) command = { action: "list" };
  else if (adapterId && positionals.length === 2 && (op === "enable" || op === "disable"))
    command = { action: "patch", adapterId, payload: { enabled: op === "enable" } };
  else if (adapterId && positionals.length === 2 && (op === "refresh" || op === "remove")) command = { action: op, adapterId };
  else if (op === "effect" && adapterId && tool && effect && positionals.length === 4) command = { action: "effect", adapterId, tool, effect };
  else throw new Error("Invalid adapter command. See alter-node --help");
  let release;
  try { release = lock(dir, "run"); }
  catch (error) {
    if ((error as { errcode?: number }).errcode !== 5) throw error;
    return liveCommand(dir, command);
  }
  try {
    const runtime = nodeAdapters(dir);
    try { return await execute(runtime, command); }
    finally { await runtime.close(); }
  } finally { release(); }
}
