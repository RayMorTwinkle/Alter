export type FeishuConfig = { appId: string; appSecret: string; domain: "feishu" | "lark" };

export type FeishuUserConfig = FeishuConfig & { redirectUri: string };

export function feishuConfigFromEnv(env: NodeJS.ProcessEnv): FeishuUserConfig | undefined {
  const appId = env.ALTER_FEISHU_APP_ID?.trim();
  const appSecret = env.ALTER_FEISHU_APP_SECRET?.trim();
  if (!appId && !appSecret) return undefined;
  if (!appId || !appSecret) throw new Error(`Missing ALTER_FEISHU_${appId ? "APP_SECRET" : "APP_ID"}`);
  const domain = env.ALTER_FEISHU_DOMAIN?.trim() || "feishu";
  if (domain !== "feishu" && domain !== "lark") throw new Error("ALTER_FEISHU_DOMAIN requires feishu or lark");
  const redirectUri = env.ALTER_FEISHU_REDIRECT_URI?.trim() ||
    `http://127.0.0.1:${env.ALTER_WEB_PORT || 4317}/api/feishu/oauth/callback`;
  return { appId, appSecret, domain, redirectUri };
}
