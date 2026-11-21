import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type RequestBody = {
  model: string; stream: boolean; messages: { role: string; content: string }[];
  tools?: { function: { name: string } }[];
  reasoning_effort?: string;
};

export async function fakeGateway(reply: (body: RequestBody, response: ServerResponse) => void) {
  const requests: RequestBody[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions" || req.headers.authorization !== "Bearer offline-key") {
      res.writeHead(400).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body: RequestBody = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    reply(body, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests,
    async close() {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

export function delta(res: ServerResponse, value: object, finish: string | null = null) {
  if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = { choices: [{ index: 0, delta: value, finish_reason: finish }] };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function end(res: ServerResponse, finish: string) {
  delta(res, {}, finish);
  res.end('data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2}}}\n\ndata: [DONE]\n\n');
}

export function say(res: ServerResponse, text: string) {
  delta(res, { content: text });
  end(res, "stop");
}

export function toolCall(res: ServerResponse, name: string, args: object) {
  delta(res, { tool_calls: [{ index: 0, type: "function", id: `call_${name}`, function: { name, arguments: "{" } }] });
  delta(res, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(1) } }] });
  end(res, "tool_calls");
}

export function httpError(res: ServerResponse, status: number) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "gateway unavailable" } }));
}
