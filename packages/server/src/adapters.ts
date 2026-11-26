import { AdapterError, fields, openAdapterEngine, type AdapterView, type openSecrets } from "@alter/adapters";
import { defineTool, type AlterApp, type PluginView } from "@alter/core";

function pluginView(v: AdapterView): PluginView {
  return { id: v.capabilityId, name: v.name, enabled: v.enabled, status: v.status, settings: [], values: {},
    provides: { channels: [], capabilities: v.tools.map(t => v.capabilityId + "_" + t.name), sources: [] } };
}

export function openAdapters(app: AlterApp, dir: string, secrets: ReturnType<typeof openSecrets>) {
  const engine = openAdapterEngine(dir, secrets, {
    unregister: (id, preserve) => app.replacePlugin(id, undefined, preserve),
    register: (v, call) => app.replacePlugin(v.capabilityId, {
      capability: { id: v.capabilityId, mainLeasable: true, actions: v.tools.map(({ name, effect }) => ({ name, effect })) },
      tools: v.tools.map(t => defineTool({ name: v.capabilityId + "_" + t.name, description: t.description, parameters: t.inputSchema,
        async execute(args, _api, ctx) { return { ...await call(t.name, args, ctx.abortSignal), details: { untrusted: true } }; },
      })),
    }),
  });
  return { ...engine, views: () => engine.list().map(pluginView),
    getPlugin(cap: string) {
      const adapter = engine.list().find(v => v.capabilityId === cap);
      if (!adapter) throw new AdapterError(404, "Unknown plugin");
      return {
        check: async () => pluginView(await engine.refresh(adapter.id)),
        async patch(input: Record<string, unknown>) { fields(input, "enabled"); return pluginView(await engine.patch(adapter.id, input)); },
      };
    },
  };
}
export type Adapters = ReturnType<typeof openAdapters>;
