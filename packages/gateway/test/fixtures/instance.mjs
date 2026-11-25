import { createHash } from "node:crypto";
import { createServer } from "node:http";

const server = createServer(async (req, res) => {
  if (req.url === "/crash") { res.end("bye", () => process.exit(1)); return; }
  if (req.url === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: first\n\n");
    return;
  }
  if (req.url === "/api/gateway/instance") { res.end(JSON.stringify({ rss: process.memoryUsage.rss() })); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  res.end(JSON.stringify({ headers: req.headers, url: req.url, method: req.method, body: Buffer.concat(chunks).toString(),
    pid: process.pid, id: process.env.ALTER_USER_ID, role: process.env.ALTER_ROLE, data: process.env.ALTER_DATA_DIR }));
});
server.on("upgrade", (req, socket, head) => {
  const id = process.env.ALTER_USER_ID;
  if (req.headers["x-alter-user"] !== id || req.headers["x-alter-gateway-secret"] !== process.env.ALTER_GATEWAY_SECRET ||
      (req.url === "/api/node/connect" && req.headers.authorization !== "Bearer " + id + ".fixture")) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  let bytes = head;
  function reply() {
    while (bytes.length >= 6 && bytes.length >= 6 + (bytes[1] & 127)) {
      const length = bytes[1] & 127;
      const payload = Buffer.from(bytes.subarray(6, 6 + length));
      for (let i = 0; i < length; ++i) payload[i] ^= bytes[2 + i % 4];
      const opcode = bytes[0];
      bytes = bytes.subarray(6 + length);
      if (opcode === 0x88) { socket.end(Buffer.from([0x88, 0])); return; }
      socket.write(Buffer.concat([Buffer.from([0x81, length]), payload]));
    }
  }
  reply();
  socket.on("data", chunk => { bytes = Buffer.concat([bytes, chunk]); reply(); });
  socket.on("error", () => socket.destroy());
});
server.listen(Number(process.env.ALTER_WEB_PORT), "127.0.0.1", () => process.send("ready"));
process.on("disconnect", () => process.exit(0));
