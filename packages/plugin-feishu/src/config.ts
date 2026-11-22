export type FeishuConfig = { appId: string; appSecret: string; domain: "feishu" | "lark" };

export function feishuConfigFromEnv(env: NodeJS.ProcessEnv): FeishuConfig | undefined {
  const appId = env.ALTER_FEISHU_APP_ID?.trim();
  const appSecret = env.ALTER_FEISHU_APP_SECRET?.trim();
  if (!appId && !appSecret) return undefined;
  if (!appId || !appSecret) throw new Error(`Missing ALTER_FEISHU_${appId ? "APP_SECRET" : "APP_ID"}`);
  const domain = env.ALTER_FEISHU_DOMAIN?.trim() || "feishu";
  if (domain !== "feishu" && domain !== "lark") throw new Error("ALTER_FEISHU_DOMAIN requires feishu or lark");
  return { appId, appSecret, domain };
}
