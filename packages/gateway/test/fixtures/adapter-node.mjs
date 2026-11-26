// Real node runtime with an empty harness inventory and a test-owned pairing directory.
import { pair } from "../../../node/src/config.ts";
import { runNode } from "../../../node/src/connection.ts";

process.once("message", ({ dir, server, token }) => {
  pair(dir, server, token, "Laptop", []);
  const node = runNode(dir, []);
  process.once("disconnect", () => { void node.stop(); });
});
