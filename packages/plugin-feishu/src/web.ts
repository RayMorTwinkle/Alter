import type { PluginRoute, PluginRouteContext, PluginView, PluginWebExtensions } from "@alter/core";
import type { FeishuAccount, FeishuPairing } from "./index.ts";
import { feishuGuide } from "./settings.ts";

const callback = "/api/feishu/oauth/callback";
function redirect(ctx: PluginRouteContext, configured: unknown) {
  return typeof configured === "string" && configured ? configured : ctx.origin() + callback;
}
function oauthCallback(account?: FeishuAccount): PluginRoute {
  return { method: "GET", path: callback, publicCallback: true, async handle({ req, res, json }) {
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!account) return json(404, { error: "Feishu is not configured" });
    const params = new URL(req.url!, "http://localhost").searchParams;
    const single = (key: string) => params.getAll(key).length === 1 ? params.get(key) : null;
    let status = 400;
    let message = "授权请求无效或已过期，请从 Web 设置重新连接。";
    try {
      if (await account.callback(single("state"), single("code"))) {
        res.writeHead(302, { Location: "/" }).end();
        return;
      }
    } catch (error) {
      const { name, code, statusCode } = error as Error & { code?: unknown; statusCode?: unknown };
      console.error("Feishu OAuth callback failed:", name, statusCode ?? "", code ?? "");
      status = 502;
      message = "飞书账号连接失败，请检查应用权限和回调地址后重试。";
    }
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
      .end(`<!doctype html><meta charset="utf-8"><title>飞书授权失败</title><p>${message}</p><a href="/">返回 Alter</a>`);
  } };
}

export function feishuSetupWeb(view?: () => PluginView): PluginWebExtensions {
  return { routes: [oauthCallback(), { method: "GET", path: "/api/plugins/feishu/guide",
    handle: ctx => ctx.json(200, feishuGuide(redirect(ctx, view?.().values.ALTER_FEISHU_REDIRECT_URI))) }] };
}

export function feishuWeb(surface?: { pairing(): FeishuPairing }, account?: FeishuAccount,
  redirectUri?: (ctx: PluginRouteContext) => string): PluginWebExtensions {
  const routes: PluginRoute[] = [];
  if (surface) routes.push({ method: "GET", path: "/api/feishu", async handle({ json }) {
    json(200, { ...surface.pairing(), account: await account?.status() ?? { connected: false } });
  } });
  if (account) routes.push(oauthCallback(account), { method: "GET", path: "/api/feishu/oauth/start",
    handle(ctx) { ctx.res.writeHead(302, { Location: account.start(redirectUri?.(ctx)) }).end(); } },
    { method: "POST", path: "/api/feishu/account/disconnect", async handle({ mutation }) {
      await account.disconnect();
      await mutation(204);
    } });
  return { routes, externalDelivery: !!surface };
}
