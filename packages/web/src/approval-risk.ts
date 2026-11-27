import type { ExtPluginEffect } from "./types.ts";

const sends = new Set(["mail_send", "mail_reply", "mail_forward", "feishu_send", "feishu_reply"]);
const local = new Set(["notes", "calendar", "memory", "schedule"]);

export function approvalRisk(tool: string, effect?: ExtPluginEffect, capability = tool.split("_", 1)[0]!) {
  if (!effect) return "unknown";
  if (effect !== "write") return effect;
  if (sends.has(tool)) return "externalSend";
  return local.has(capability) ? "localWrite" : "write";
}
