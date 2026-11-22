import { once } from "node:events";
import { join } from "node:path";
import { createGatewayModels, gatewayConfig, loadRepoEnv, openAlter, openNodeSqliteStorage } from "@alter/core";
import { createMailPlugin, mailConfigFromEnv } from "@alter/plugin-mail";
import { createWebServer } from "./server.ts";

async function start() {
  loadRepoEnv();
  const password = process.env.ALTER_WEB_PASSWORD;
  if (!password) throw new Error("Missing ALTER_WEB_PASSWORD");
  const host = process.env.ALTER_WEB_HOST || "127.0.0.1";
  const port = Number(process.env.ALTER_WEB_PORT || 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid ALTER_WEB_PORT");
  const config = gatewayConfig();
  const { models, mainModel, taskModel, thinking } = await createGatewayModels(config);
  // Connectors load only when configured, so a fresh checkout still starts with the demo capabilities.
  const mail = mailConfigFromEnv(process.env);
  const plugins = mail ? [createMailPlugin(mail)] : [];
  const app = await openAlter(
    await openNodeSqliteStorage(join(config.dataDir, "main.sqlite")), models, mainModel, taskModel, thinking,
    { plugins, approvalTimeoutMs: config.approvalTimeoutMs },
  );
  console.log("Alter plugins:", plugins.map(plugin => plugin.capability.id).join(", ") || "none");
  try {
    const web = await createWebServer(app, { password, dataDir: config.dataDir });
    try {
      web.server.listen(port, host);
      await once(web.server, "listening");
      app.harness.resume();
      console.log("Alter web listening on", web.server.address());
      await new Promise<void>(resolve => {
        function shutdown() {
          process.off("SIGINT", shutdown);
          process.off("SIGTERM", shutdown);
          resolve();
        }
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
    } finally { await web.close(); }
  } finally { await app.close(); }
}

if (import.meta.main) await start();
