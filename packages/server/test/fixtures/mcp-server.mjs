import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "adapter-fixture", version: "1" }, { capabilities: { tools: {} } });
const empty = { type: "object" };
server.setRequestHandler(ListToolsRequestSchema, async request => request.params?.cursor ? {
  tools: [{ name: "read-back", description: "ordinary tool", inputSchema: empty },
    // Like some real servers, this schema omits type: "object".
    { name: "fail", description: "return an MCP error", inputSchema: { properties: {} } }],
} : {
  tools: [{ name: "Read.Back", description: "read input", inputSchema: { type: "object", properties: { text: { type: "string" } } },
    annotations: { readOnlyHint: true } }], nextCursor: "2",
});
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name === "fail") return { isError: true, content: [{ type: "text", text: "fixture failure" }] };
  if (params.name === "Read.Back") return { content: [
    { type: "text", text: process.env.ADAPTER_TOKEN === "fixture-value-27b" ? "authenticated" : "missing" },
    { type: "text", text: params.arguments?.text ?? "" },
  ] };
  return { content: [{ type: "text", text: String(process.pid) }, { type: "image", mimeType: "image/png", data: "aW1n" }] };
});
await server.connect(new StdioServerTransport());
