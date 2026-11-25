import { HttpError } from "../static.ts";
import { check, fields } from "./config.ts";
import type { AdapterPreset } from "./types.ts";

export const adapterPresets: AdapterPreset[] = [
  { id: "github", name: "GitHub", description: "通过官方 MCP 服务访问 GitHub 仓库、议题和拉取请求。",
    authMethods: ["gh", "token"], variants: ["readonly", "full"] },
];

export function presetConfig(presetId: string, input: Record<string, unknown>) {
  const preset = adapterPresets.find(p => p.id === presetId);
  if (!preset) throw new HttpError(404, "Unknown adapter preset");
  fields(input, "auth token variant id name");
  const { auth, token, variant = "readonly", id = preset.id, name = preset.name } = input;
  check(auth === "gh" || auth === "token", "Expected gh or token authentication");
  check(variant === "readonly" || variant === "full", "Expected readonly or full variant");
  if (auth === "token") check(typeof token === "string" && token.trim(), "Expected GitHub token");
  else check(token === undefined, "Unexpected token for gh authentication");
  const base = "https://api.githubcopilot.com/mcp/";
  return { kind: "mcp", id, name, config: { transport: "http",
    url: variant === "readonly" ? base + "readonly" : base, ...(variant === "readonly" ? { readOnly: true } : {}),
    headers: { Authorization: auth === "gh" ? "Bearer {{gh-token}}" : "Bearer {{secret:GITHUB_TOKEN}}" } },
    ...(typeof token === "string" ? { secrets: { GITHUB_TOKEN: token.trim() } } : {}) };
}
