import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { dailyMinutes } from "./calendar-time.ts";
import { defaultTimeZone } from "./clock.ts";

export const defaultApprovalTimeoutMs = 24 * 60 * 60_000;

export function validateApprovalTimeout(ms: number, variable = "ALTER_APPROVAL_TIMEOUT_MINUTES") {
  if (!Number.isSafeInteger(Date.now() + ms) || !Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`Approval timeout must be a positive millisecond duration with a representable deadline (${variable})`);
  }
  return ms;
}

const thinkingLevels: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

export function loadRepoEnv() {
  try {
    process.loadEnvFile(resolve(repoRoot, ".env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function dataDirectory(env = process.env) {
  return resolve(repoRoot, env.ALTER_DATA_DIR?.trim() || "data");
}

export function proactiveConfig(env = process.env) {
  const budget = Number(env.ALTER_PROACTIVE_DAILY_TOKENS ?? 3_000_000);
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error("ALTER_PROACTIVE_DAILY_TOKENS must be a nonnegative integer");
  const reportTime = env.ALTER_REPORT_TIME?.trim() || "21:00";
  dailyMinutes(reportTime);
  const mute = (env.ALTER_MUTE ?? "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  const hours = (env.ALTER_HEARTBEAT_HOURS ?? "08:00-23:00").trim().split("-").map(value => {
    const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(value.trim());
    if (!match) throw new Error("Expected ALTER_HEARTBEAT_HOURS as HH:mm-HH:mm");
    const clock = match[1]!.padStart(2, "0") + ":" + (match[2] ?? "00");
    dailyMinutes(clock);
    return clock;
  });
  if (hours.length !== 2 || hours[0] === hours[1]) throw new Error("Expected distinct ALTER_HEARTBEAT_HOURS start and end");
  const heartbeat = { enabled: env.ALTER_HEARTBEAT?.trim().toLowerCase() !== "off", start: hours[0]!, end: hours[1]! };
  return { budget, reportTime, mute, heartbeat };
}

export function gatewayConfig(env = process.env) {
  function required(key: string) {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  }
  function chain(key: string) {
    const ids = required(key).split(",").map(id => id.trim());
    if (ids.some(id => !/^[^\s/,]+(?:\/[^\s/,]+)+$/.test(id))) {
      throw new Error(`${key} must contain comma-separated gateway model IDs (e.g. provider/model)`);
    }
    return ids;
  }
  function thinking(key: string, fallback: ModelThinkingLevel) {
    const value = env[key]?.trim() || fallback;
    if (!thinkingLevels.includes(value as ModelThinkingLevel)) {
      throw new Error(`${key} must be one of ${thinkingLevels.join(", ")}`);
    }
    return value as ModelThinkingLevel;
  }
  const endpoint = new URL(required("ALTER_LLM_BASE_URL"));
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("ALTER_LLM_BASE_URL must be an HTTP(S) API base URL");
  }
  if (endpoint.pathname === "/") endpoint.pathname = "/v1";
  const firstTokenMs = Number(env.ALTER_FIRST_TOKEN_TIMEOUT_MS ?? 60_000);
  if (!Number.isSafeInteger(firstTokenMs) || firstTokenMs <= 0 || firstTokenMs > 2_147_483_647) {
    throw new Error("ALTER_FIRST_TOKEN_TIMEOUT_MS must be a positive 32-bit integer");
  }
  return {
    baseUrl: endpoint.href.replace(/\/+$/, ""),
    apiKey: required("ALTER_LLM_API_KEY"),
    main: chain("ALTER_MAIN_MODEL"), task: chain("ALTER_TASK_MODEL"),
    thinking: { main: thinking("ALTER_MAIN_THINKING", "medium"), task: thinking("ALTER_TASK_THINKING", "high") },
    approvalTimeoutMs: validateApprovalTimeout(env.ALTER_APPROVAL_TIMEOUT_MINUTES === undefined
      ? defaultApprovalTimeoutMs : Number(env.ALTER_APPROVAL_TIMEOUT_MINUTES) * 60_000),
    firstTokenMs, dataDir: dataDirectory(env), timeZone: env.ALTER_TZ?.trim() || defaultTimeZone,
  };
}
