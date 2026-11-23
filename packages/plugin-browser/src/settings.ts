import type { PluginDescription, PluginStatus } from "@alter/core";
import { runEgo } from "./ego.ts";
import { createBrowserPlugin } from "./index.ts";

export const browserDescription: PluginDescription = { id: "browser", name: "浏览器",
  provides: { channels: [], capabilities: ["browser"], sources: [] }, settings: [] };

export function browserInstance(runner = runEgo) {
  return { plugin: createBrowserPlugin({ runner }),
    async status(): Promise<PluginStatus> {
      const ok = await runner('console.log("ALTER_EGO_READY " + Array.isArray(await listTaskSpaces()))')
        .then(out => out.split(/\r?\n/).includes("ALTER_EGO_READY true"), () => false);
      return { state: ok ? "ok" : "error", ...(!ok && { detail: "无法连接 ego-browser，请检查安装和运行状态。" }),
        checks: [{ id: "ego", label: "ego-browser 可用", ok }] };
    },
  };
}
