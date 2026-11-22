import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { dailyMinutes } from "./calendar-time.ts";
import { defaultTimeZone } from "./clock.ts";

export const defaultApprovalTimeoutMs = 24 * 60 * 60_000;

export function validateApprovalTimeout(ms: number) {
  if (!Number.isSafeInteger(Date.now() + ms) || !Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error("Approval timeout must be a positive millisecond duration with a representable deadline (ALTER_APPROVAL_TIMEOUT_MINUTES)");
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
  const budget = Number(env.ALTER_PROACTIVE_DAILY_TOKENS ?? 200_000);
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error("ALTER_PROACTIVE_DAILY_TOKENS must be a nonnegative integer");
  const digestTime = env.ALTER_DIGEST_TIME?.trim() || "21:00";
  const goalReviewTime = env.ALTER_GOAL_REVIEW_TIME?.trim() || "09:00";
  dailyMinutes(digestTime);
  dailyMinutes(goalReviewTime);
  const mute = (env.ALTER_MUTE ?? "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  return { budget, digestTime, goalReviewTime, mute };
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
