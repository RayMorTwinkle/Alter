import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadRepoEnv } from "../../core/src/config.ts";
import { gatewayDirectory, readGatewaySecret } from "../../server/src/gateway-trust.ts";
import { openAccounts } from "./accounts.ts";
import { manageInstances } from "./instances.ts";
import { gatewayServer } from "./server.ts";

function port(value: string) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("Invalid port: " + value);
  return n;
}

function sharedSecret(env: NodeJS.ProcessEnv, dir: string) {
  const existing = readGatewaySecret(env);
  if (existing) return existing;
  const temp = join(dir, "secret." + randomBytes(8).toString("hex"));
  writeFileSync(temp, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  try { linkSync(temp, join(dir, "secret")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  finally { unlinkSync(temp); }
  const secret = readGatewaySecret(env);
  if (!secret) throw new Error("Empty gateway secret file");
  return secret;
}

export async function openGateway(env: NodeJS.ProcessEnv) {
  const listenPort = port(env.ALTER_GATEWAY_PORT || "4300");
  const basePort = port(env.ALTER_INSTANCE_BASE_PORT || "4400");
  const admin = new URL(env.ALTER_ADMIN_INSTANCE || "http://127.0.0.1:4317");
  if (admin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(admin.hostname) ||
      admin.pathname !== "/" || admin.username || admin.password || admin.search || admin.hash) throw new Error("Expected local HTTP ALTER_ADMIN_INSTANCE");
  const adminPort = port(admin.port || "80");
  if (listenPort === adminPort) throw new Error("Gateway and administrator instance must have different ports");
  const dir = gatewayDirectory(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secret = sharedSecret(env, dir);
  const accounts = await openAccounts(join(dir, "accounts.sqlite"), basePort, env.ALTER_ADMIN_USERNAME || "admin", env.ALTER_WEB_PASSWORD, [adminPort, listenPort]);
  const instances = manageInstances({ env, usersDir: join(dirname(dir), "users"), secret, adminPort });
  const web = gatewayServer(accounts, instances);
  try {
    web.server.listen(listenPort, env.ALTER_GATEWAY_HOST || "127.0.0.1");
    await once(web.server, "listening");
  } catch (error) { await web.close(); accounts.close(); throw error; }
  return { server: web.server, async close() { await web.close(); accounts.close(); } };
}

if (import.meta.main) {
  loadRepoEnv();
  const web = await openGateway(process.env);
  console.log("Alter gateway listening on", web.server.address());
  await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
  await web.close();
}
