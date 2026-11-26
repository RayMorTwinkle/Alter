import { spawn } from "node:child_process";
import { reply } from "./types.ts";
import { expandMap, type CliConfig, type Connection, type Expand } from "./types.ts";

export async function discoverCli(config: CliConfig, name: string, expand: Expand, lifetime: AbortSignal): Promise<Connection> {
  const prefix = await Promise.all((config.args ?? []).map(expand));
  const env = { ...process.env, ...await expandMap(config.env, expand) };
  function run(args: string[], input: string | undefined, signal: AbortSignal, limit: number) {
    const timeout = AbortSignal.timeout(config.timeoutMs ?? 120_000);
    const stop = AbortSignal.any([timeout, signal]);
    stop.throwIfAborted();
    return new Promise<{ output: string; code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = spawn(config.command, [...prefix, ...args], { cwd: config.cwd, env, shell: false, stdio: "pipe" });
      const kill = () => {
        child.kill("SIGKILL");
        // Descendants may still hold the pipe descriptors after the command exits.
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
      };
      stop.addEventListener("abort", kill, { once: true });
      let output = "";
      for (const stream of [child.stdout, child.stderr]) stream.setEncoding("utf8").on("data", (text: string) => {
        if (output.length < limit) output += text.slice(0, limit - output.length);
      });
      child.on("error", reject);
      child.stdin.on("error", (e: NodeJS.ErrnoException) => { if (e.code !== "EPIPE") reject(e); });
      child.stdin.end(input);
      child.once("close", (code, exitSignal) => {
        stop.removeEventListener("abort", kill);
        if (stop.aborted) reject(new Error(timeout.aborted ? "CLI timed out" : "CLI cancelled"));
        else resolve({ code, signal: exitSignal, output });
      });
    });
  }
  const help = config.help?.trim() || (await run(["--help"], undefined, lifetime, 8000)).output;
  return { tools: [{ name: "run", defaultEffect: "write", description: [name, help.slice(0, 8000)].filter(Boolean).join("\n"),
    inputSchema: { type: "object", properties: { args: { type: "array", items: { type: "string" } }, stdin: { type: "string" } },
      required: ["args"], additionalProperties: false },
    async call({ args, stdin }, signal) {
      if (!Array.isArray(args) || !args.every(v => typeof v === "string") || (stdin !== undefined && typeof stdin !== "string")) throw new Error("Invalid CLI arguments");
      const result = await run(args, stdin, signal, 20_000);
      return reply(JSON.stringify(result), result.code !== 0);
    },
  }] };
}
