import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ApprovalMode = "shadow" | "auto" | "off";
export const isApprovalMode = (value: unknown): value is ApprovalMode =>
  value === "shadow" || value === "auto" || value === "off";

export function openSettings(dir?: string) {
  const path = dir && join(dir, "settings.json");
  let mode: unknown = process.env.ALTER_APPROVAL_MODEL ?? "shadow";
  if (path) {
    try { mode = JSON.parse(readFileSync(path, "utf8")).approvalModel; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!isApprovalMode(mode)) throw new Error("approvalModel must be shadow, auto or off");
  let approvalModel = mode;
  return {
    get approvalModel() { return approvalModel; },
    set(value: ApprovalMode) {
      if (path) {
        const temp = path + "." + randomUUID();
        writeFileSync(temp, JSON.stringify({ approvalModel: value }), { mode: 0o600 });
        renameSync(temp, path);
      }
      approvalModel = value;
    },
  };
}
