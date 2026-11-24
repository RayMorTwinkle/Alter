import { aborted } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { expandMap, type Connection, type DiscoveredTool, type Expand, type McpConfig, type Result } from "./types.ts";

type LooseTools = { tools?: { name: string; description?: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean } }[]; nextCursor?: string };
const loose = { safeParse: (data: unknown) => ({ success: true as const, data }) } as never;
function objectSchema(schema: unknown): Record<string, unknown> {
  const value = schema && typeof schema === "object" && !Array.isArray(schema) ? schema as Record<string, unknown> : {};
  return { ...value, type: "object", properties: value.properties ?? {} };
}

export async function discoverMcp(config: McpConfig, expand: Expand, signal: AbortSignal, disconnected: (reason: string) => void): Promise<Connection> {
  if (config.transport === "stdio") {
    const transport = new StdioClientTransport({ command: config.command, args: config.args?.map(expand), env: expandMap(config.env, expand), stderr: "ignore" });
    return discover(transport, signal, disconnected);
  }
  const url = new URL(expand(config.url));
  const options = { requestInit: { headers: expandMap(config.headers, expand) } };
  try { return await discover(new StreamableHTTPClientTransport(url, options), signal, disconnected); }
  catch (error) {
    if (!(error instanceof StreamableHTTPError) || ![400, 404, 405].includes(error.code ?? 0)) throw error;
    signal.throwIfAborted();
    return discover(new SSEClientTransport(url, options), signal, disconnected);
  }
}

async function discover(transport: Transport, signal: AbortSignal, disconnected: (reason: string) => void): Promise<Connection> {
  const client = new Client({ name: "alter", version: "1" });
  let ready = false;
  client.onclose = () => { if (ready) disconnected("MCP connection closed"); };
  client.onerror = error => { if (ready && !(transport instanceof StdioClientTransport)) disconnected(error.message); };
  async function close() {
    ready = false;
    if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
      const timer = setTimeout(() => { void client.close(); }, 2000).unref();
      try { await transport.terminateSession(); }
      catch { /* The remote session may already have expired. */ }
      finally { clearTimeout(timer); }
    }
    await client.close();
  }
  try {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    deadline.throwIfAborted();
    await Promise.race([client.connect(transport, { signal: deadline }), aborted(deadline, client).then(() => deadline.throwIfAborted())]);
    const tools: DiscoveredTool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      // Real servers often publish schemas the SDK rejects (for example without type: "object"), so read the list loosely.
      const page = await client.request({ method: "tools/list", params: cursor ? { cursor } : {} }, loose, { signal, timeout: 20_000 }) as LooseTools;
      if (!Array.isArray(page?.tools)) throw new Error("MCP tools/list returned no tools array");
      for (const tool of page.tools.filter(tool => typeof tool?.name === "string")) tools.push({
        name: tool.name, description: tool.description ?? tool.name, inputSchema: objectSchema(tool.inputSchema),
        defaultEffect: tool.annotations?.readOnlyHint === true ? "read" : "write",
        async call(args, signal) {
          const result = await client.callTool({ name: tool.name, arguments: args }, CallToolResultSchema, { signal });
          const content = CallToolResultSchema.parse(result).content;
          const text = content.filter(c => c.type === "text").map(c => c.text).join("\n");
          const output: Result["output"] = text ? [{ type: "text", text }] : [];
          for (const c of content) if (c.type === "image") output.push({ type: "image", data: c.data, mimeType: c.mimeType });
          return { output, isError: result.isError === true };
        },
      });
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("Repeated MCP tools cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    ready = true;
    return { tools, close };
  } catch (error) { await close(); throw error; }
}
