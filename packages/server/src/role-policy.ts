export const RESTRICTED_HOST_CAPABILITIES = ["browser", "adapters", "ext-plugins", "cli", "feishu", "service"] as const;

export function hostPolicy(env = process.env) {
  const restricted = env.ALTER_ROLE === "user";
  function allowsPlugin(id: string) {
    return !restricted || !(id === "browser" || id === "feishu" || /^(ext|cli|mcp|api)-/.test(id));
  }
  function allowsRoute(path: string, method?: string) {
    const [, api, resource, plugin] = path.split("/");
    if (!restricted || api !== "api") return true;
    if (resource === "plugins" && plugin) return allowsPlugin(plugin);
    if (path === "/api/service") return method === "GET";
    return resource !== "adapters" && resource !== "ext-plugins" && resource !== "feishu";
  }
  return { restricted, allowsPlugin, allowsRoute };
}
