import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { atomicWrite } from "./config.ts";

export const reportSchema = z.object({ summary: z.string().trim().min(1), refs: z.array(z.object({ kind: z.string(), ref: z.string() })) });
export const finishScript = fileURLToPath(import.meta.url);

if (process.argv[1] === finishScript) {
  const file = process.argv[2];
  if (!file) throw new Error("缺少报告路径");
  const server = new McpServer({ name: "alter", version: "1" });
  server.registerTool("finish", { description: "提交本轮任务报告和引用。", inputSchema: reportSchema }, async report => {
    atomicWrite(file, JSON.stringify(report));
    return { content: [{ type: "text", text: "报告已记录" }] };
  });
  await server.connect(new StdioServerTransport());
}
