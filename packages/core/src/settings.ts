import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { conversationDoc } from "./runtime.ts";
import type { FeedbackSettings } from "./feedback-settings.ts";

export const defaultCompactAtTokens = 400_000;
export const isCompactAtTokens = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export const AllowedCapabilities = conversationDoc<{ capabilities: string[] }>("always-allowed-capabilities", () => ({ capabilities: [] }));

export type ApprovalMode = "on" | "off";
export const isApprovalMode = (value: unknown): value is ApprovalMode =>
  value === "on" || value === "off";

export type HeartbeatSettings = { enabled: boolean; start: string; end: string };
export function isHeartbeatSettings(value: unknown): value is HeartbeatSettings {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 3) return false;
  const { enabled, start, end } = value as Partial<HeartbeatSettings>;
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  return typeof enabled === "boolean" && typeof start === "string" && typeof end === "string" &&
    time.test(start) && time.test(end) && start !== end;
}

export function openSettings(dir: string | undefined, defaults: HeartbeatSettings, feedback: () => Promise<Readonly<FeedbackSettings>>) {
  const path = dir && join(dir, "settings.json");
  let saved: { approvalModel?: unknown; heartbeat?: unknown; compactAtTokens?: unknown } = {};
  if (path) {
    try { saved = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const stored = saved.approvalModel === undefined ? process.env.ALTER_APPROVAL_MODEL ?? "on" : saved.approvalModel;
  const mode = stored === "shadow" || stored === "auto" ? "on" : stored;
  if (!isApprovalMode(mode)) throw new Error("approvalModel must be on or off");
  if (saved.heartbeat !== undefined && !isHeartbeatSettings(saved.heartbeat)) throw new Error("Invalid saved heartbeat settings");
  if (saved.compactAtTokens !== undefined && !isCompactAtTokens(saved.compactAtTokens)) throw new Error("Invalid saved compactAtTokens");
  let compactAtTokens = saved.compactAtTokens ?? defaultCompactAtTokens;
  let approvalModel = mode;
  let heartbeat = saved.heartbeat;
  const settings = {
    feedback,
    get approvalModel() { return approvalModel; },
    get heartbeat() { return heartbeat ?? defaults; },
    get compactAtTokens() { return compactAtTokens; },
    set(value: ApprovalMode, window = heartbeat, threshold = compactAtTokens) {
      if (path) {
        const temp = path + "." + randomUUID();
        try {
          writeFileSync(temp, JSON.stringify({ approvalModel: value, heartbeat: window, compactAtTokens: threshold }), { flag: "wx", mode: 0o600 });
          renameSync(temp, path);
        } finally { rmSync(temp, { force: true }); }
      }
      approvalModel = value;
      heartbeat = window;
      compactAtTokens = threshold;
    },
  };
  if (saved.approvalModel !== undefined && saved.approvalModel !== mode) settings.set(mode);
  return settings;
}
