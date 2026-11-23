import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginDescription, PluginStatus } from "@alter/core";
import { scopes } from "./account.ts";
import { feishuConfigFromEnv } from "./config.ts";
import { createFeishuConnector } from "./connector.ts";
import { createFeishuSurface } from "./index.ts";
import { sdkTransport } from "./transport.ts";

export const feishuDescription: PluginDescription = { id: "feishu", name: "飞书",
  provides: { channels: ["feishu"], capabilities: ["feishu"], sources: ["feishu"] }, settings: [
    { key: "ALTER_FEISHU_APP_ID", label: "App ID", type: "text", required: true, help: "开放平台「凭证与基础信息」中的应用 ID。" },
    { key: "ALTER_FEISHU_APP_SECRET", label: "App Secret", type: "secret", required: true, help: "同一应用的 App Secret。" },
    { key: "ALTER_FEISHU_DOMAIN", label: "服务区域", type: "select", required: false, help: "国内版选 feishu，国际版选 lark。",
      options: ["feishu", "lark"], default: "feishu" },
    { key: "ALTER_FEISHU_REDIRECT_URI", label: "OAuth 回调地址", type: "text", required: false, help: "留空使用当前 Web 访问地址。" },
  ] };

export function feishuGuide(redirectUri: string) {
  const tenant = ["im:message.p2p_msg:readonly", "im:message.group_at_msg:readonly", "im:message:send_as_bot"];
  return { permissionsJson: JSON.stringify({ scopes: { tenant, user: scopes } }, null, 2), redirectUri, eventsMode: "long-connection" as const,
    steps: ["创建企业自建应用并启用机器人，在设置页保存 App ID 和 App Secret。",
      "在权限管理中批量导入权限 JSON，并将下方回调地址登记到安全设置。",
      "为事件和回调选择长连接，订阅 im.message.receive_v1 和 card.action.trigger，发布应用版本。",
      "运行连接检查，在机器人私聊中发送配对码。", "点击连接飞书账号，完成用户身份授权，再次检查状态。"] };
}

// Existing installations keep their original files. Other app identities get independent owners and OAuth tokens.
function identityDirectory(dir: string, identity: string, legacy: string) {
  const marker = join(dir, "feishu-identity");
  try { writeFileSync(marker, legacy, { mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return readFileSync(marker, "utf8") === identity ? dir : join(dir, "feishu-" + identity);
}

export function feishuInstance(env: NodeJS.ProcessEnv, dir: string, changed: () => void, legacyEnv: NodeJS.ProcessEnv) {
  const config = feishuConfigFromEnv(env)!;
  const hash = (domain: string, id: string) => createHash("sha256").update(domain + "/" + id).digest("hex");
  const identity = hash(config.domain, config.appId);
  const legacy = legacyEnv.ALTER_FEISHU_APP_ID?.trim();
  const dataDir = identityDirectory(dir, identity, legacy ? hash(legacyEnv.ALTER_FEISHU_DOMAIN?.trim() || "feishu", legacy) : identity);
  const connector = createFeishuConnector({ config, dataDir, changed });
  const transport = sdkTransport(config, changed);
  const surface = createFeishuSurface({ transport, dataDir, changed });
  let credentialError: string | undefined = "尚未验证应用凭证。";
  async function status(probe = true): Promise<PluginStatus> {
    if (probe) {
      const base = config.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
      credentialError = await fetch(base + "/open-apis/auth/v3/tenant_access_token/internal", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
        signal: AbortSignal.timeout(12_000), redirect: "error" }).then(async response => {
        if (!response.ok) return "获取 tenant token 失败（HTTP " + response.status + "）。";
        const body = await response.json();
        if (body.code === 0 && typeof body.tenant_access_token === "string" && body.tenant_access_token) return;
        const code = typeof body.code === "number" ? "（错误码 " + body.code + "）" : "";
        return "飞书未签发 tenant token" + code + "，请核对应用凭证和服务区域。";
      }).catch(() => "无法取得飞书凭证验证响应，请检查网络后重试。");
    }
    const connection = transport.connection();
    const paired = surface.isPaired();
    const authorized = (await connector.account.status()).connected;
    const checks = [{ id: "credentials", label: "应用凭证有效", ok: !credentialError, ...(credentialError && { detail: credentialError }) },
      { id: "connection", label: "长连接已连上", ok: connection === "connected" },
      { id: "pairing", label: "机器人已配对", ok: paired }, { id: "account", label: "用户账号已授权", ok: authorized }];
    if (credentialError) return { state: "error", detail: credentialError, checks };
    if (connection !== "connected") return { state: connection === "failed" ? "error" : "connecting", detail: "飞书长连接尚未建立。", checks };
    return paired && authorized ? { state: "ok", checks } : { state: "needs-config", detail: "请完成机器人配对和用户账号授权。", checks };
  }
  return { plugin: connector.plugin, surface, account: connector.account, status };
}
