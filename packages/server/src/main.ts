import { once } from "node:events";
import type { Server } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createGatewayModels, gatewayConfig, loadRepoEnv, openAlter, openNodeSqliteStorage } from "@alter/core";
import { mkdir } from "node:fs/promises";
import { installedPlugins } from "./plugins.ts";
import { createWebServer } from "./server.ts";

export async function listen(server: Server, port: number, host: string) {
  const deadline = performance.now() + 15_000;
  for (;;) {
    try {
      server.listen(port, host);
      await once(server, "listening");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || performance.now() >= deadline) throw error;
      await delay(250);
    }
  }
}

async function start() {
  const managed = process.env.ALTER_AUTH === "gateway" && !!process.send;
  if (!managed) loadRepoEnv();
  const password = process.env.ALTER_WEB_PASSWORD ?? "";
  if (process.env.ALTER_AUTH !== "gateway" && !password) throw new Error("Missing ALTER_WEB_PASSWORD");
  const host = process.env.ALTER_WEB_HOST || "127.0.0.1";
  const port = Number(process.env.ALTER_WEB_PORT || 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid ALTER_WEB_PORT");
  const config = gatewayConfig();
  const { models, mainModel, taskModel, thinking } = await createGatewayModels(config);
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const app = await openAlter(
    await openNodeSqliteStorage(join(config.dataDir, "main.sqlite")), models, mainModel, taskModel, thinking,
    { demos: false, deferredLeases: true, timeZone: config.timeZone, approvalTimeoutMs: config.approvalTimeoutMs },
  );
  try {
    const plugins = installedPlugins(app, config.dataDir);
    const web = await createWebServer(app, { password, dataDir: config.dataDir, plugins });
    let shutdown!: () => void;
    const stopped = new Promise<void>(resolve => { shutdown = resolve; });
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    if (managed) {
      process.once("disconnect", shutdown);
      if (!process.connected) shutdown();
    }
    try {
      await listen(web.server, port, host);
      await plugins.start();
      app.harness.resume();
      console.log("Alter web listening on", web.server.address());
      if (managed && process.connected) process.send?.("ready");
      await stopped;
    } finally {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      try { await web.close(); } finally { await plugins.close(); }
    }
  } finally {
    try { await app.close(); } finally { if (managed && process.connected) process.disconnect?.(); }
  }
}

if (import.meta.main) await start();
