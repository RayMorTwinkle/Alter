import { isApprovalMode, isCompactAtTokens, isHeartbeatSettings, type AlterApp } from "@alter/core";
import { HttpError } from "./static.ts";

export function settingsWriter(app: AlterApp) {
  let settingsWrite = Promise.resolve();
  return async (patch: Record<string, unknown>) => {
    const write = settingsWrite.then(async () => {
      if (!Object.keys(patch).length || Object.keys(patch).some(k => !["heartbeat", "approvalModel", "compactAtTokens"].includes(k)) ||
          ("compactAtTokens" in patch && !isCompactAtTokens(patch.compactAtTokens)) ||
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
      const prevThreshold = app.settings.compactAtTokens;
      const mode = app.settings.approvalModel;
      app.settings.set(isApprovalMode(patch.approvalModel) ? patch.approvalModel : mode, "heartbeat" in patch ? heartbeat : undefined,
        isCompactAtTokens(patch.compactAtTokens) ? patch.compactAtTokens : prevThreshold);
      if ("heartbeat" in patch) {
        try { await app.heartbeat.start(app.now(), true); await app.reports.sync(); }
        catch (error) { app.settings.set(mode, prev, prevThreshold); throw error; }
      }
    });
    settingsWrite = write.catch(() => {});
    await write;
  };
}
