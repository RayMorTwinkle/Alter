import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ApprovalMode = "shadow" | "auto" | "off";
export const isApprovalMode = (value: unknown): value is ApprovalMode =>
  value === "shadow" || value === "auto" || value === "off";

export type HeartbeatSettings = { enabled: boolean; start: string; end: string };
export function isHeartbeatSettings(value: unknown): value is HeartbeatSettings {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 3) return false;
  const { enabled, start, end } = value as Partial<HeartbeatSettings>;
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  return typeof enabled === "boolean" && typeof start === "string" && typeof end === "string" &&
    time.test(start) && time.test(end) && start !== end;
}

export function openSettings(dir: string | undefined, defaults: HeartbeatSettings) {
  const path = dir && join(dir, "settings.json");
  let saved: { approvalModel?: unknown; heartbeat?: unknown } = {};
  if (path) {
    try { saved = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const mode = saved.approvalModel === undefined ? process.env.ALTER_APPROVAL_MODEL ?? "shadow" : saved.approvalModel;
  if (!isApprovalMode(mode)) throw new Error("approvalModel must be shadow, auto or off");
  if (saved.heartbeat !== undefined && !isHeartbeatSettings(saved.heartbeat)) throw new Error("Invalid saved heartbeat settings");
  let approvalModel = mode;
  let heartbeat = saved.heartbeat;
  return {
    get approvalModel() { return approvalModel; },
    get heartbeat() { return heartbeat ?? defaults; },
    set(value: ApprovalMode, window = heartbeat) {
      if (path) {
        const temp = path + "." + randomUUID();
        try {
          writeFileSync(temp, JSON.stringify({ approvalModel: value, heartbeat: window }), { flag: "wx", mode: 0o600 });
          renameSync(temp, path);
        } finally { rmSync(temp, { force: true }); }
      }
      approvalModel = value;
      heartbeat = window;
    },
  };
}
