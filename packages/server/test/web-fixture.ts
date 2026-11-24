import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import { createGatewayModels, gatewayConfig, openAlter, openNodeSqliteStorage,
  type HeartbeatEvent, type MemoryItem, type SurfaceEvent, type SurfaceState } from "@alter/core";
import { createCalendarPlugin } from "@alter/plugin-calendar";
import type { createFeishuConnector, FeishuPairing } from "@alter/plugin-feishu";
import { fakeGateway, say } from "../../core/test/fixtures/gateway.ts";
import type { PluginManager } from "../src/plugin-manager.ts";
import type { ServiceOptions } from "../src/service.ts";
import { createWebServer } from "../src/server.ts";

export const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

export async function setup(route: Parameters<typeof fakeGateway>[0] = (_, res) => say(res, "ok"), withCalendar = false, feishu?: { pairing(): FeishuPairing; connector?: ReturnType<typeof createFeishuConnector> }, now = Date.now,
  makePlugins?: (app: Awaited<ReturnType<typeof openAlter>>, dir: string) => PluginManager, service?: ServiceOptions) {
  const gateway = await fakeGateway(route);
  cleanup.push(gateway.close);
  const dir = await mkdtemp(join(tmpdir(), "alter-web-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const dist = join(dir, "dist");
  const config = gatewayConfig({ ALTER_LLM_BASE_URL: gateway.baseUrl, ALTER_LLM_API_KEY: "offline-key",
    ALTER_MAIN_MODEL: "offline/main", ALTER_TASK_MODEL: "offline/task", ALTER_DATA_DIR: dir });
  const { models, mainModel, taskModel } = await createGatewayModels(config);
  async function open() {
    const calendar = withCalendar ? createCalendarPlugin({ dataDir: dir, timeZone: "Asia/Shanghai" }) : undefined;
    const plugins = calendar ? [calendar] : [];
    const connector = feishu?.connector;
    const app = await openAlter(await openNodeSqliteStorage(join(dir, "main.sqlite")), models, mainModel, taskModel, {},
      { demos: !makePlugins, deferredLeases: makePlugins ? ["calendar"] : [], plugins: connector ? [...plugins, connector.plugin] : plugins, now });
    cleanup.push(app.close);
    const manager = makePlugins?.(app, dir);
    if (manager) { cleanup.push(manager.close); await manager.start(); }
    const web = await createWebServer(app, { password: "offline secret", dist, dataDir: dir, plugins: manager, calendar, feishu, feishuAccount: connector?.account, service });
    cleanup.push(web.close);
    web.server.listen(0, "127.0.0.1");
    await once(web.server, "listening");
    app.harness.resume();
    const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
    let cookie = "";
    function post(path: string, value?: unknown, type = "application/json") {
      return fetch(base + path, { method: "POST", headers: { "Content-Type": type, cookie }, body: JSON.stringify(value) });
    }
    async function login() {
      const response = await post("/api/login", { password: "offline secret" });
      expect(response.status).toBe(204);
      const header = response.headers.get("set-cookie")!;
      expect(header).toContain("HttpOnly");
      expect(header).toContain("SameSite=Strict");
      cookie = header.split(";")[0]!;
    }
    const read = (path: string) => fetch(base + path, { headers: { cookie } });
    return {
      app, post, read, login, base, dist, dir, server: web.server, sessionCookie: () => cookie,
      async close() { await web.close(); await manager?.close(); await app.close(); },
      async state(): Promise<SurfaceState> { return (await read("/api/state")).json(); },
    };
  }
  return { ...await open(), reopen: open };
}

type Event<T> = SurfaceEvent | import("../../web/src/types.ts").ExtPluginsEvent
  | { event: "sources"; data: import("@alter/plugin-sources").SourceView[] } | { event: "plugins"; data: import("@alter/core").PluginView[] }
  | { event: "heartbeat"; data: HeartbeatEvent } | { event: "snapshot"; data: SurfaceState }
  | { event: "calendar"; data: unknown } | { event: "memory"; data: T };

export async function stream<T = MemoryItem[]>(read: (path: string) => Promise<Response>) {
  const response = await read("/api/events");
  expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: Event<T>[] = [];
  const ended = (async () => {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let index: number;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (frame.startsWith(":")) continue;
        const [event, data] = frame.split("\n");
        events.push({ event: event!.slice(7) as Event<T>["event"], data: JSON.parse(data!.slice(6)) });
      }
    }
  })();
  cleanup.push(async () => { await reader.cancel(); await ended; });
  const seen = async (match: (e: Event<T>) => boolean) => { await expect.poll(() => events.some(match)).toBe(true); };
  await seen(e => e.event === "snapshot");
  expect(events[0]?.event).toBe("snapshot");
  return { events, seen, ended };
}
