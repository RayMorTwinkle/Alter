import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { atomicWrite } from "./config.ts";

export const reportSchema = z.object({ summary: z.string().trim().min(1), refs: z.array(z.object({ kind: z.string(), ref: z.string() })) });
declare const __ALTER_BUNDLE__: boolean | undefined;
// The downloadable build is one file, so every entry point (run, finish, login item) is that file.
export const cliScript = fileURLToPath(typeof __ALTER_BUNDLE__ === "undefined" ? new URL("./cli.ts", import.meta.url) : import.meta.url);

export async function serveFinish(file: string | undefined) {
  if (!file) throw new Error("缺少报告路径");
  const server = new McpServer({ name: "alter", version: "1" });
  server.registerTool("finish", { description: "提交本轮任务报告和引用。", inputSchema: reportSchema }, async report => {
    atomicWrite(file, JSON.stringify(report));
    return { content: [{ type: "text", text: "报告已记录" }] };
  });
  await server.connect(new StdioServerTransport());
}
