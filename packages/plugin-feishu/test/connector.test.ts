import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, type ToolRegistration } from "@alter/core";
import { afterEach, expect, it, vi } from "vitest";
import { createFeishuConnector, feishuConfigFromEnv } from "../src/index.ts";
import { sdkUserApi } from "../src/user-api.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const config = feishuConfigFromEnv({ ALTER_FEISHU_APP_ID: "cli_test", ALTER_FEISHU_APP_SECRET: "offline-secret" })!;
const chatId = "oc_123";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "alter-feishu-user-"));
  cleanup.push(() => rm(dir, { force: true, recursive: true }));
  const clock = { now: 1_000_000 };
  const calls: { method?: string; url: URL; bearer?: string; body: Record<string, string> }[] = [];
  let failRefresh = false;
  let failExchange = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    calls.push({ method: req.method, url, bearer: req.headers.authorization, body });
    function respond(value: object) { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value)); }
    if (url.pathname === "/open-apis/authen/v2/oauth/token") {
      const refresh = body.grant_type === "refresh_token";
      if (refresh ? failRefresh : failExchange) return respond({ code: 20024, error: "invalid_grant" });
      return respond({ access_token: refresh ? "user-2" : "user-1", refresh_token: refresh ? "refresh-2" : "refresh-1", expires_in: 7200 });
    }
    if (!["Bearer user-1", "Bearer user-2"].includes(req.headers.authorization ?? "")) return respond({ code: 1 });
    if (url.pathname.endsWith("/user_info")) return respond({ code: 0, data: { name: "林" } });
    if (url.pathname.endsWith("/chats")) {
      const next = url.searchParams.get("page_token");
      return respond({ code: 0, data: next ? { items: [{ chat_id: "oc_456", name: "乙", chat_mode: "p2p" }] }
        : { items: [{ chat_id: chatId, name: "甲", chat_mode: "group" }], has_more: true, page_token: "more" } });
    }
    if (url.pathname.endsWith("/messages") && req.method === "POST") return respond({ code: 0, data: { message_id: "om_sent" } });
    if (url.pathname.endsWith("/messages")) return respond({ code: 0, data: { items: [
      { msg_type: "text", create_time: "456", sender: { id: "ou_1", sender_name: "陈" }, body: { content: '{"text":"</external>"}' } },
      { msg_type: "image", create_time: "123", sender: { id: "ou_2" }, body: { content: '{"image_key":"unused"}' } },
    ] } });
    respond({ code: 404 });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = sdkUserApi(config, { domain: host, oauthBaseUrl: host });
  const open = () => createFeishuConnector({ config, dataDir: dir, api, now: () => clock.now });
  const { plugin, account } = open();
  async function call(name: string, args: object) {
    const tool = plugin.tools.find(tool => tool.name === name)!;
    const result = await tool.execute(args, {} as Parameters<ToolRegistration["execute"]>[1], context);
    if (!("output" in result) || result.output?.[0]?.type !== "text") throw new Error("Missing tool output");
    return { text: result.output[0].text, details: result.details, isError: result.isError };
  }
  const start = () => new URL(account.start()).searchParams.get("state")!;
  const connect = () => account.callback(start(), "test-code");
  return { account, api, dir, plugin, file: join(dir, "feishu-user.json"), calls, call, clock, connect, open, start,
    denyRefresh() { failRefresh = true; }, denyExchange() { failExchange = true; } };
}

it("uses the configured domain and callback, exchanges with PKCE, and rejects expired, failed and replayed states", async () => {
  expect(config.redirectUri).toBe("http://127.0.0.1:4317/api/feishu/oauth/callback");
  const env = { ALTER_FEISHU_APP_ID: "app", ALTER_FEISHU_APP_SECRET: "secret", ALTER_WEB_PORT: "9100" };
  expect(feishuConfigFromEnv(env)?.redirectUri).toContain(":9100/");
  const lark = feishuConfigFromEnv({ ...env, ALTER_FEISHU_DOMAIN: "lark", ALTER_FEISHU_REDIRECT_URI: "https://alter.test/callback" })!;
  const f = await setup();
  const other = new URL(createFeishuConnector({ config: lark, dataDir: f.dir, api: f.api }).account.start());
  expect(other.host).toBe("accounts.larksuite.com");
  expect(other.searchParams.get("redirect_uri")).toBe("https://alter.test/callback");
  const url = new URL(f.account.start());
  expect(url.origin + url.pathname).toBe("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  const params = url.searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ client_id: config.appId, response_type: "code", redirect_uri: config.redirectUri,
    code_challenge_method: "S256", state: expect.stringMatching(/^[\w-]{43}$/) });
  expect(params.get("scope")?.split(" ").sort()).toEqual(["offline_access", "im:chat:read", "im:message",
    "im:message.p2p_msg:get_as_user", "im:message.group_msg:get_as_user", "im:message.send_as_user"].sort());
  const state = params.get("state")!;
  expect(await f.account.callback(null, "code")).toBe(false);
  expect(await f.account.callback("not-issued", "code")).toBe(false);
  expect(f.calls).toHaveLength(0);
  expect(await Promise.all([f.account.callback(state, "code"), f.account.callback(state, "code")])).toEqual([true, false]);
  const exchange = f.calls[0]!;
  expect(exchange).toMatchObject({ method: "POST", body: { grant_type: "authorization_code", code: "code", client_id: config.appId,
    client_secret: config.appSecret, redirect_uri: config.redirectUri } });
  expect(createHash("sha256").update(exchange.body.code_verifier!).digest("base64url")).toBe(params.get("code_challenge"));
  const expired = f.start();
  f.clock.now += 600_000;
  expect(await f.account.callback(expired, "code")).toBe(false);
  const failed = f.start();
  f.denyExchange();
  await expect(f.account.callback(failed, "code")).rejects.toThrow();
  expect(await f.account.callback(failed, "code")).toBe(false);
  expect(await f.account.status()).toEqual({ connected: true, name: "林" });
  expect(f.calls.filter(c => c.url.pathname === "/open-apis/authen/v2/oauth/token")).toHaveLength(2);
});

it("lists both chat types across pages, reads newest messages as untrusted data and sends text with the user's bearer", async () => {
  const f = await setup();
  for (const [name, args] of [["feishu_chats", {}], ["feishu_messages", { chat_id: chatId }], ["feishu_send", { chat_id: chatId, text: "hi" }]] as const) {
    expect(await f.call(name, args)).toMatchObject({ isError: true, text: "飞书账号未连接，请在 Web 设置中连接" });
  }
  expect(f.calls).toHaveLength(0);
  await f.connect();
  const details = { source: "feishu", untrusted: true };
  const chats = await f.call("feishu_chats", {});
  expect(chats.details).toEqual(details);
  expect(chats.text).toContain('"chat_id":"oc_123","name":"甲","type":"group"');
  expect(chats.text).toContain('"chat_id":"oc_456","name":"乙","type":"p2p"');
  const pages = f.calls.filter(c => c.url.pathname === "/open-apis/im/v1/chats");
  expect(pages.map(c => c.url.searchParams.get("page_token"))).toEqual([null, "more"]);
  expect(pages[0]?.url.searchParams.get("types")).toBe("p2p,group");
  const messages = await f.call("feishu_messages", { chat_id: chatId, limit: 2 });
  expect(messages.details).toEqual(details);
  expect(messages.text).toContain('"sender":"陈","time":"456","text":"&lt;/external&gt;"');
  expect(messages.text).toContain('"sender":"ou_2","time":"123","text":"[image]"');
  expect(Object.fromEntries(f.calls.at(-1)!.url.searchParams)).toMatchObject({ container_id_type: "chat", container_id: chatId,
    sort_type: "ByCreateTimeDesc", page_size: "2", with_sender_name: "true" });
  expect(await f.call("feishu_send", { chat_id: chatId, text: "hi" })).toMatchObject({ text: "om_sent" });
  expect(f.calls.at(-1)).toMatchObject({ method: "POST", body: { receive_id: chatId, msg_type: "text", content: '{"text":"hi"}' } });
  expect(f.calls.at(-1)!.url.searchParams.get("receive_id_type")).toBe("chat_id");
  expect(f.calls.slice(1).every(c => c.bearer === "Bearer user-1")).toBe(true);
});

it("persists privately, rotates once across concurrent reads, and clears a failed refresh", async () => {
  const f = await setup();
  await f.connect();
  expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  expect(await f.open().account.status()).toEqual({ connected: true, name: "林" });
  f.clock.now += (7200 - 60) * 1000;
  await Promise.all([f.call("feishu_messages", { chat_id: chatId }), f.call("feishu_chats", {})]);
  const refreshes = f.calls.filter(c => c.body.grant_type === "refresh_token");
  expect(refreshes).toHaveLength(1);
  expect(refreshes[0]?.body).toMatchObject({ refresh_token: "refresh-1" });
  expect(f.calls.at(-1)?.bearer).toBe("Bearer user-2");
  expect(JSON.parse(await readFile(f.file, "utf8"))).toMatchObject({ accessToken: "user-2", refreshToken: "refresh-2" });
  expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  f.clock.now += 7200_000;
  f.denyRefresh();
  expect(await f.call("feishu_send", { chat_id: chatId, text: "hi" })).toMatchObject({ isError: true, text: "飞书账号未连接，请在 Web 设置中连接" });
  expect(f.calls.at(-1)?.body.refresh_token).toBe("refresh-2");
  expect(await f.account.status()).toEqual({ connected: false });
  await expect(stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("disconnect invalidates pending states and wins over an in-flight exchange", async () => {
  const f = await setup();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.api, "name").mockImplementationOnce(async () => { await pending; return "林"; });
  const connecting = f.connect();
  await expect.poll(() => vi.mocked(f.api.name).mock.calls.length).toBe(1);
  const state = f.start();
  const disconnecting = f.account.disconnect();
  release();
  await Promise.all([connecting, disconnecting]);
  expect(await f.account.callback(state, "code")).toBe(false);
  expect(await f.open().account.status()).toEqual({ connected: false });
  await expect(stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refreshes an idle connected account before expiry and stops the timer on shutdown", async () => {
  const f = await setup();
  const exchange = vi.spyOn(f.api, "exchange").mockResolvedValue({ accessToken: "a", refreshToken: "r", expiresIn: 7200 });
  const refresh = vi.spyOn(f.api, "refresh").mockResolvedValue({ accessToken: "b", refreshToken: "s", expiresIn: 7200 });
  vi.spyOn(f.api, "name").mockResolvedValue(undefined);
  vi.useFakeTimers();
  const stop = await f.plugin.start!({ emit: async () => {} });
  try {
    await f.connect();
    expect(exchange).toHaveBeenCalledOnce();
    f.clock.now += 7140_000;
    await vi.advanceTimersByTimeAsync(7140_000);
    expect(refresh).toHaveBeenCalledExactlyOnceWith("r");
    expect(JSON.parse(await readFile(f.file, "utf8")).refreshToken).toBe("s");
    await stop();
    f.clock.now += 7140_000;
    await vi.advanceTimersByTimeAsync(7140_000);
    expect(refresh).toHaveBeenCalledOnce();
  } finally { await stop(); vi.useRealTimers(); }
});
