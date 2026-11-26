import type { PluginRoute, PluginWebExtensions } from "@alter/core";
import { templates } from "./config.ts";
import type { Sources } from "./index.ts";

export function sourcesWeb(sources?: Sources): PluginWebExtensions {
  const routes: PluginRoute[] = [
    { method: "GET", path: "/api/sources/templates", handle: ctx => ctx.json(200, templates) },
    { method: "GET", path: "/api/sources", handle: ctx => ctx.json(200, sources?.list() ?? []) },
  ];
  if (!sources) return { routes };
  const item = /^\/api\/sources\/[^/]+$/;
  routes.push(
    { method: "POST", path: "/api/sources/preview", handle: async ctx => ctx.mutation(200, await sources.preview(await ctx.body())) },
    { method: "POST", path: "/api/sources", handle: async ctx => ctx.mutation(201, await sources.create(await ctx.body())) },
    { method: "PATCH", path: item, handle: async ctx => ctx.mutation(200, await sources.patch(ctx.path.split("/")[3]!, await ctx.body())) },
    { method: "DELETE", path: item, async handle(ctx) { await sources.remove(ctx.path.split("/")[3]!); await ctx.mutation(204); } },
  );
  return { routes, sse: [{ event: "sources", snapshot: sources.list, subscribe: cb => sources.subscribe(cb) }] };
}
