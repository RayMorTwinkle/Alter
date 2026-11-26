import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { context, type ToolRegistration } from "@alter/core";
import { afterEach, expect, it, vi } from "vitest";
import { createFeishuConnector, feishuConfigFromEnv } from "../src/index.ts";
import { scopes } from "../src/account.ts";
import { feishuGuide } from "../src/settings.ts";
import { sdkUserApi } from "../src/user-api.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const config = feishuConfigFromEnv({ ALTER_FEISHU_APP_ID: "cli_test", ALTER_FEISHU_APP_SECRET: "offline-secret" })!;
const chatId = "oc_123";

type Route = (url: URL, res: ServerResponse) => void;
async function setup(routes: Record<string, Route> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "alter-feishu-user-"));
  cleanup.push(() => rm(dir, { force: true, recursive: true }));
  const clock = { now: 1_000_000 };
  const calls: { method?: string; url: URL; bearer?: string; body: Record<string, string> }[] = [];
  let failRefresh = false;
  let failExchange = false;
  let grant: string | undefined = scopes.join(" ");
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
      return respond({ access_token: refresh ? "user-2" : "user-1", refresh_token: refresh ? "refresh-2" : "refresh-1", expires_in: 7200, scope: refresh ? undefined : grant });
    }
    if (!["Bearer user-1", "Bearer user-2"].includes(req.headers.authorization ?? "")) return respond({ code: 1 });
    if (routes[url.pathname]) return routes[url.pathname]!(url, res);
    if (url.pathname.endsWith("/user_info")) return respond({ code: 0, data: { name: "林" } });
    if (url.pathname.endsWith("/chats")) {
      const next = url.searchParams.get("page_token");
      return respond({ code: 0, data: next ? { items: [{ chat_id: "oc_456", name: "乙", chat_mode: "p2p" }] }
        : { items: [{ chat_id: chatId, name: "甲", chat_mode: "group" }], has_more: true, page_token: "more" } });
    }
    if (url.pathname.endsWith("/messages") && req.method === "POST") return respond({ code: 0, data: { message_id: "om_sent" } });
    if (url.pathname.endsWith("/messages") && url.searchParams.has("start_time")) {
      const more = !url.searchParams.has("page_token");
      return respond({ code: 0, data: { has_more: more, page_token: "next", items: [
        { message_id: more ? "om_a" : "om_b", create_time: more ? "1100" : "1200", msg_type: "text",
          sender: { id: "ou_1" }, body: { content: '{"text":"hello"}' } },
        { message_id: "outside", create_time: "1201", msg_type: "text" },
      ] } });
    }
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
    const result = await tool.execute(tool.prepareArguments?.(args) ?? args, {} as Parameters<ToolRegistration["execute"]>[1], context);
    if (!("output" in result) || result.output?.[0]?.type !== "text") throw new Error("Missing tool output");
    return { text: result.output[0].text, details: result.details, isError: result.isError };
  }
  async function rows(name: string, args: object) {
    const result = await call(name, args);
    expect(result.isError, result.text).toBe(false);
    expect(result.details).toEqual({ source: "feishu", untrusted: true });
    const wrapped = /^<external source="feishu">(.*)<\/external>$/s.exec(result.text)![1]!;
    return JSON.parse(wrapped.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"));
  }
  const start = () => new URL(account.start()).searchParams.get("state")!;
  const connect = () => account.callback(start(), "test-code");
  return { account, api, dir, plugin, file: join(dir, "feishu-user.json"), calls, call, rows, clock, connect, open, start,
    grant(value: string) { grant = value; }, denyRefresh() { failRefresh = true; }, denyExchange() { failExchange = true; } };
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
  expect(params.get("scope")?.split(" ")).toEqual(scopes);
  expect(JSON.parse(feishuGuide(config.redirectUri).permissionsJson).scopes.user).toEqual(scopes);
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
  expect(chats.text).toContain('"page_token":"more"');
  expect((await f.call("feishu_chats", { query: "乙", page_token: "more" })).text).toContain('"chat_id":"oc_456","name":"乙","type":"p2p"');
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

it("polls both pages with the user's bearer, stable message IDs and exact millisecond bounds", async () => {
  const f = await setup();
  const where = { channel: "feishu", chatId } as const;
  const source = f.plugin.watchSource!;
  await expect(source.authorize(where)).rejects.toThrow("未连接");
  await f.connect();
  await source.authorize(where);
  const events = await source.poll(where, 1050, 1201);
  expect(events).toMatchObject(["om_a", "om_b"].map(ref => ({ ref, chatId, contact: "ou_1", text: "hello", untrusted: true })));
  const pages = f.calls.filter(c => c.url.searchParams.has("start_time"));
  expect(pages.map(p => p.url.searchParams.get("page_token"))).toEqual([null, "next"]);
  expect(pages.every(p => p.bearer === "Bearer user-1" && p.url.searchParams.get("start_time") === "1" && p.url.searchParams.get("end_time") === "2")).toBe(true);
});

it("resolves the exact chat across directory pages without reading messages", async () => {
  const f = await setup();
  await f.connect();
  const state = { conversationId: 1 as Parameters<ToolRegistration["execute"]>[1]["conversationId"], snapshot: async () => undefined };
  const describe = (chat_id: string) => f.plugin.describe!({ tool: "feishu_send", arguments: { chat_id, text: "private" } }, state);
  expect(await describe("oc_456")).toEqual({ chat_id: "oc_456", name: "乙", type: "p2p" });
  expect(await describe("missing")).toBeUndefined();
  expect(f.calls.some(c => c.url.pathname.endsWith("/messages"))).toBe(false);
});

const im = "/open-apis/im/v1";
const directory = "/open-apis/contact/v3/users/search";
const json = (res: ServerResponse, data: object) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ code: 0, data }));
const unavailable: Route = (_, res) => { res.writeHead(404).end(); };
const post = { message_id: "om_post", thread_id: "omt_1", parent_id: "om_parent", create_time: "1100", msg_type: "post",
  sender: { id: "ou_1", sender_name: "林" }, body: { content: JSON.stringify({ zh_cn: { title: "日报", content: [
    [{ tag: "text", text: "参考" }, { tag: "a", text: "会议记录", href: "https://example.test" }],
    [{ tag: "at", user_name: "陈" }, { tag: "img", image_key: "img_1" }] ] } }) } };

it("filters chat pages and reads rich messages with exact ms bounds, order and reusable resource keys", async () => {
  const f = await setup({ [im + "/messages"]: (url, res) => json(res, { has_more: !url.searchParams.has("page_token"), page_token: "page2",
    items: [post, { message_id: "om_file", create_time: "1199", msg_type: "file", body: { content: '{"file_key":"file_1","file_name":"预算.pdf"}' } },
      { ...post, create_time: "1099" }, { ...post, create_time: "1200" }] }) });
  await f.connect();
  expect(await f.rows("feishu_chats", { query: "乙" })).toEqual({ items: [], page_token: "more" });
  const args = { chat_id: chatId, start_time: "1970-01-01T00:00:01.100Z", end_time: 1200, limit: 50, order: "asc" };
  const result = await f.rows("feishu_messages", args);
  expect(result.items).toHaveLength(2);
  expect(result.items).toMatchObject([{ message_id: "om_post", sender: "林", sender_id: "ou_1", type: "post",
    text: "日报\n参考会议记录\n陈[image]", thread_id: "omt_1", parent_id: "om_parent", resources: [{ type: "image", file_key: "img_1" }] },
    { message_id: "om_file", resources: [{ file_key: "file_1", file_name: "预算.pdf", type: "file" }] }]);
  expect(await f.rows("feishu_messages", { ...args, page_token: result.page_token })).not.toHaveProperty("page_token");
  expect(Object.fromEntries(f.calls.at(-1)!.url.searchParams)).toMatchObject({ sort_type: "ByCreateTimeAsc", start_time: "1", end_time: "2",
    page_token: "page2", page_size: "50" });
  const count = f.calls.length;
  for (const range of [{ start_time: "yesterday" }, { start_time: 2, end_time: 1 }, { limit: 51 }]) {
    expect(await f.call("feishu_messages", { chat_id: chatId, ...range })).toMatchObject({ isError: true });
  }
  expect(f.calls).toHaveLength(count);
});

it("uses native user message search with sender, chat, ISO boundaries and server cursor", async () => {
  const f = await setup({ [im + "/messages/search"]: (url, res) => json(res, { has_more: !url.searchParams.has("page_token"), page_token: "more",
    items: [{ id: "om_1", display_info: "讨论<h>预算</h>", meta_data: { chat_id: chatId, from_id: "ou_1", type: "text",
      create_time: "1970-01-01T00:00:01.456Z" } }] }) });
  await f.connect();
  const args = { query: "预算", chat_id: chatId, from: "ou_1", start_time: 1234, end_time: "1970-01-01T00:00:01.789Z" };
  expect(await f.rows("feishu_search", args)).toMatchObject({ source: "search", page_token: "more",
    items: [{ message_id: "om_1", text: "讨论预算", sender_id: "ou_1" }] });
  await f.rows("feishu_search", { ...args, page_token: "more" });
  expect(f.calls.at(-1)).toMatchObject({ method: "POST", bearer: "Bearer user-1", body: { query: "预算",
    filter: { chat_ids: [chatId], from_ids: ["ou_1"], time_range: { start_time: "1970-01-01T00:00:01Z", end_time: "1970-01-01T00:00:02Z" } } } });
  expect(f.calls.at(-1)!.url.searchParams.get("page_token")).toBe("more");
});

it("falls back visibly to local keyword, sender and time filtering when native search is unavailable", async () => {
  const f = await setup({ [im + "/messages/search"]: (_, res) => { res.writeHead(503).end(); } });
  await f.connect();
  const args = { query: "HELLO", chat_id: chatId, from: "ou_1", start_time: 1050, end_time: 1201 };
  const first = await f.rows("feishu_search", args);
  expect(first).toMatchObject({ source: "local", items: [{ message_id: "om_a" }], page_token: "local:next" });
  expect(await f.rows("feishu_search", { ...args, page_token: first.page_token })).toMatchObject({ items: [{ message_id: "om_b" }] });
  expect(await f.rows("feishu_search", { ...args, from: "someone_else" })).toMatchObject({ items: [] });
  expect(await f.rows("feishu_search", { query: "missing" })).toMatchObject({ items: [], source: "local", notice: expect.stringContaining("10") });
  const recent = f.calls.find(call => call.url.pathname === im + "/chats")!;
  expect(Object.fromEntries(recent.url.searchParams)).toMatchObject({ page_size: "10", sort_type: "ByActiveTimeDesc" });
});

it("expands merged messages and all accessible thread pages, retaining the full message if replies are inaccessible", async () => {
  let denied = false;
  const f = await setup({ [im + "/messages/om_post"]: (_, res) => json(res, { items: [
    { ...post, msg_type: "merge_forward" }, { message_id: "child", upper_message_id: "om_post", msg_type: "text", body: { content: '{"text":"全文"}' } }] }),
    [im + "/messages"]: (url, res) => {
      if (denied) { res.writeHead(403).end(); return; }
      const next = url.searchParams.has("page_token");
      json(res, { has_more: !next, page_token: "next", items: [next ? { ...post, message_id: "om_other" } : post] });
    } });
  await f.connect();
  const result = await f.rows("feishu_message", { message_id: "om_post" });
  expect(result.items).toMatchObject([{ message_id: "om_post", type: "merge_forward" }, { upper_message_id: "om_post", text: "全文", content: '{"text":"全文"}' }]);
  expect(result.replies).toMatchObject([{ message_id: "om_other" }]);
  expect(Object.fromEntries(f.calls.at(-1)!.url.searchParams)).toMatchObject({ container_id_type: "thread", container_id: "omt_1", page_token: "next" });
  denied = true;
  expect(await f.rows("feishu_message", { message_id: "om_post" })).toMatchObject({ notice: expect.stringContaining("403"), items: result.items });
});

it("downloads binary resources privately under downloads, strips traversal and leaves no partial files", async () => {
  const bytes = Buffer.from([0, 255, 34, 0]);
  const f = await setup({ [im + "/messages/om_1/resources/file_1"]: (_, res) => res.writeHead(200, {
    "content-disposition": "attachment; filename*=UTF-8''..%2F..%5C%2F%E6%8A%A5%3F%E8%A1%A8.pdf",
    "content-type": "application/pdf" }).end(bytes) });
  await f.connect();
  const args = { message_id: "om_1", file_key: "file_1", type: "file" };
  const [first, second] = await Promise.all([f.rows("feishu_download", args), f.rows("feishu_download", args)]);
  expect(first.path).not.toBe(second.path);
  const downloads = join(f.dir, "downloads");
  expect(dirname(first.path)).toBe(downloads);
  expect(basename(first.path)).toMatch(/-报_表\.pdf$/);
  expect(first).toMatchObject({ size: 4, type: "file", mime: "application/pdf" });
  expect(await readFile(first.path)).toEqual(bytes);
  expect((await stat(first.path)).mode & 0o777).toBe(0o600);
  expect(f.calls.at(-1)?.bearer).toBe("Bearer user-1");
  expect(f.calls.at(-1)?.url.searchParams.get("type")).toBe("file");
  const count = f.calls.length;
  expect(await f.call("feishu_download", { ...args, file_key: "../feishu-user.json" })).toMatchObject({ isError: true });
  expect(f.calls).toHaveLength(count);
  vi.spyOn(f.api, "download").mockResolvedValueOnce({ disposition: "", mime: "image/png",
    stream: Readable.from((async function* () { yield bytes; throw new Error("stream interrupted"); })()) });
  expect(await f.call("feishu_download", { ...args, type: "image" })).toMatchObject({ isError: true });
  expect(await readdir(downloads)).toHaveLength(2);
  await rm(downloads, { recursive: true });
  const other = join(f.dir, "other");
  await mkdir(other);
  await symlink(other, downloads);
  expect(await f.call("feishu_download", args)).toMatchObject({ isError: true });
  expect(await readdir(other)).toEqual([]);
});

it("searches directory profiles and paginates chat members by open ID", async () => {
  const f = await setup({ [directory]: (url, res) => json(res, { items: [{ id: "ou_lin", display_info: "<h>林</h>\n设计部\n[最近联系]",
    meta_data: { i18n_names: { zh_cn: "林" }, mail_address: "lin@example.test" } }], has_more: !url.searchParams.has("page_token"), page_token: "d2" }),
    [im + "/chats/" + chatId + "/members"]: (url, res) => json(res, { items: [{ member_id: "ou_lin", name: "林" }],
      has_more: !url.searchParams.has("page_token"), page_token: "m2" }) });
  await f.connect();
  for (const query of ["林", "lin@example.test", "+8613812345678", undefined]) {
    expect(await f.rows("feishu_contacts", { query })).toMatchObject({ source: "directory", page_token: "d2",
      items: [{ open_id: "ou_lin", name: "林", email: "lin@example.test", department: "设计部" }] });
    expect(f.calls.at(-1)).toMatchObject({ method: "POST", bearer: "Bearer user-1", body: query ? { query } : { filter: { has_contact: true } } });
  }
  expect(await f.rows("feishu_contacts", { query: "林", page_token: "d2" })).not.toHaveProperty("page_token");
  const members = await f.rows("feishu_chat_members", { chat_id: chatId });
  expect(members).toEqual({ items: [{ open_id: "ou_lin", name: "林" }], page_token: "m2" });
  await f.rows("feishu_chat_members", { chat_id: chatId, page_token: members.page_token });
  expect(Object.fromEntries(f.calls.at(-1)!.url.searchParams)).toMatchObject({ member_id_type: "open_id", page_token: "m2" });
});

it("aggregates direct chat peers and member pages if directory search is unavailable", async () => {
  const f = await setup({ [directory]: unavailable, [im + "/chats"]: (url, res) => json(res, url.searchParams.has("page_token") ? { items: [
    { chat_id: "oc_old", chat_mode: "p2p" }] } : { has_more: true, page_token: "more", items: [
    { chat_id: "oc_peer", name: "Alice", chat_mode: "p2p", p2p_target_type: "user", p2p_target_id: "ou_a" },
    { chat_id: "oc_robot", name: "AliceBot", chat_mode: "p2p", p2p_target_type: "bot" }] }),
    [im + "/chats/oc_old/members"]: (url, res) => json(res, { items: [{ member_id: "ou_b", name: "Alice B" }],
      has_more: !url.searchParams.has("page_token"), page_token: "members2" }) });
  await f.connect();
  const first = await f.rows("feishu_contacts", { query: "alice" });
  expect(first).toMatchObject({ source: "p2p", items: [{ name: "Alice", open_id: "ou_a" }], page_token: "p2p:more" });
  expect(await f.rows("feishu_contacts", { query: "alice", page_token: first.page_token })).toMatchObject({ items: [{ open_id: "ou_b", name: "Alice B" }] });
  expect(f.calls.filter(c => c.url.pathname === directory)).toHaveLength(1);
});

it("replies in a thread and accepts exactly one matching DM or chat recipient", async () => {
  const f = await setup({ [im + "/messages/om_1/reply"]: (_, res) => json(res, { message_id: "om_reply" }) });
  await f.connect();
  expect(await f.call("feishu_reply", { message_id: "om_1", text: "收到", in_thread: true })).toMatchObject({ text: "om_reply" });
  expect(f.calls.at(-1)).toMatchObject({ method: "POST", bearer: "Bearer user-1", body: { msg_type: "text", content: '{"text":"收到"}', reply_in_thread: true } });
  for (const receive_id_type of [undefined, "open_id"]) {
    await f.call("feishu_send", { open_id: "ou_1", text: "hi", receive_id_type });
    expect(f.calls.at(-1)?.url.searchParams.get("receive_id_type")).toBe("open_id");
    expect(f.calls.at(-1)?.body.receive_id).toBe("ou_1");
  }
  const count = f.calls.length;
  for (const [args, expected] of [
    [{ text: "hi" }, /exactly one of "chat_id" or "open_id"/],
    [{ chat_id: chatId, open_id: "ou_1", text: "hi" }, /exactly one of "chat_id" or "open_id"/],
    [{ chat_id: chatId, receive_id_type: "open_id", text: "hi" }, /"receive_id_type".*"chat_id"/],
    [{ chat_id: chatId, text: null }, /"text": expected string, got null/],
  ] as const) {
    await expect(f.call("feishu_send", args)).rejects.toThrow(expected);
  }
  expect(f.calls).toHaveLength(count);
});

it("reports all upstream tool errors without request secrets and declares matching capability effects", async () => {
  const cases: [string, object, string][] = [
    ["chats", {}, im + "/chats"], ["messages", { chat_id: chatId }, im + "/messages"],
    ["search", { query: "预算" }, im + "/messages/search"], ["message", { message_id: "om_1" }, im + "/messages/om_1"],
    ["download", { message_id: "om_1", file_key: "img_1", type: "image" }, im + "/messages/om_1/resources/img_1"],
    ["contacts", {}, directory], ["chat_members", { chat_id: chatId }, im + "/chats/" + chatId + "/members"],
    ["send", { chat_id: chatId, text: "hi" }, im + "/messages"], ["reply", { message_id: "om_1", text: "hi" }, im + "/messages/om_1/reply"],
  ];
  const fail: Route = (_, res) => { res.writeHead(429, { "content-type": "application/json" }).end('{"code":99991400,"msg":"sensitive"}'); };
  const f = await setup(Object.fromEntries(cases.map(([, , path]) => [path, fail])));
  await f.connect();
  for (const [action, args] of cases) {
    const result = await f.call("feishu_" + action, args);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/99991400|429/);
    expect(result.text).not.toMatch(/sensitive|user-1/);
    expect(f.plugin.capability.actions).toContainEqual({ name: action, effect: ["send", "reply"].includes(action) ? "write" : "read" });
  }
  expect(f.plugin.tools.map(t => t.name).sort()).toEqual(cases.map(([action]) => "feishu_" + action).sort());
  expect(f.calls.slice(1).every(c => c.bearer === "Bearer user-1")).toBe(true);
});

it("retains partial grants across refresh and restart, flags legacy accounts and repairs both by reconnecting", async () => {
  const f = await setup();
  const granted = scopes.filter(scope => scope !== "search:message");
  f.grant(granted.join(" "));
  await f.connect();
  const partial = { connected: false, missingScopes: ["search:message"], detail: expect.stringContaining("重新连接") };
  expect(await f.account.status()).toMatchObject(partial);
  f.clock.now += 7200_000;
  expect(await f.account.status()).toMatchObject(partial);
  expect(await f.open().account.status()).toMatchObject(partial);
  const legacy = JSON.parse(await readFile(f.file, "utf8"));
  delete legacy.scopes;
  await writeFile(f.file, JSON.stringify(legacy));
  const reopened = f.open();
  expect(await reopened.account.status()).toMatchObject({ connected: false, detail: expect.stringContaining("未记录") });
  f.grant(scopes.join(" "));
  await reopened.account.callback(new URL(reopened.account.start()).searchParams.get("state"), "new-code");
  expect(await f.open().account.status()).toEqual({ connected: true, name: "林" });
});

it("distinguishes JSON attachments from error envelopes and downloads inline images", async () => {
  const f = await setup({ [im + "/messages/om_1/resources/json"]: (_, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'),
    [im + "/messages/om_1/resources/error"]: (_, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"code":234043,"msg":"denied"}'),
    [im + "/messages/om_1/resources/img"]: (_, res) => res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([137, 80, 78, 71])) });
  await f.connect();
  const args = { message_id: "om_1", type: "file" };
  const file = await f.rows("feishu_download", { ...args, file_key: "json" });
  expect(await readFile(file.path, "utf8")).toBe('{"ok":true}');
  expect(await f.rows("feishu_download", { ...args, type: "image", file_key: "img" })).toMatchObject({ type: "image", mime: "image/png", size: 4 });
  expect(await f.call("feishu_download", { ...args, file_key: "error" })).toMatchObject({ isError: true, text: expect.stringContaining("234043") });
  expect(await readdir(join(f.dir, "downloads"))).toHaveLength(2);
});
