import type { IncomingMessage } from "node:http";
import { isApprovalMode, isHeartbeatSettings, type AlterApp } from "@alter/core";
import type { PluginManager } from "./plugin-manager.ts";
import { HttpError } from "./static.ts";

export function redirectUri(req: IncomingMessage, plugins?: PluginManager) {
  const configured = plugins?.list().find(p => p.id === "feishu")?.values.ALTER_FEISHU_REDIRECT_URI;
  if (typeof configured === "string") return configured;
  const protocol = "encrypted" in req.socket && req.socket.encrypted ? "https" : "http";
  const host = req.headers.host;
  if (!host || !/^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/.test(host)) throw new HttpError(400, "Invalid Host");
  return protocol + "://" + host + "/api/feishu/oauth/callback";
}

export function settingsWriter(app: AlterApp) {
  let settingsWrite = Promise.resolve();
  return async (patch: Record<string, unknown>) => {
    const write = settingsWrite.then(async () => {
      if (!Object.keys(patch).length || Object.keys(patch).some(k => !["heartbeat", "approvalModel"].includes(k)) ||
          ("approvalModel" in patch && !isApprovalMode(patch.approvalModel))) throw new HttpError(400, "Invalid settings");
      const prev = app.settings.heartbeat;
      let heartbeat = prev;
      if ("heartbeat" in patch) {
        const h = patch.heartbeat;
        if (!h || typeof h !== "object" || !Object.keys(h).length || Array.isArray(h)) throw new HttpError(400, "Invalid heartbeat");
        const next = { ...prev, ...h };
        if (!isHeartbeatSettings(next)) throw new HttpError(400, "Invalid heartbeat window");
        heartbeat = next;
      }
      const mode = app.settings.approvalModel;
      app.settings.set(isApprovalMode(patch.approvalModel) ? patch.approvalModel : mode, "heartbeat" in patch ? heartbeat : undefined);
      if ("heartbeat" in patch) {
        try { await app.heartbeat.start(app.now(), true); }
        catch (error) { app.settings.set(mode, prev); throw error; }
      }
    });
    settingsWrite = write.catch(() => {});
    await write;
  };
}
