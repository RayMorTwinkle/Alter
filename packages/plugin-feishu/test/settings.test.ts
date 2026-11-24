import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WSClient } from "@larksuiteoapi/node-sdk";
import { expect, it, vi } from "vitest";
import { scopes } from "../src/account.ts";
import { feishuInstance } from "../src/settings.ts";

it("probes tenant credentials independently of the socket, pairing and user account", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alter-feishu-probe-"));
  const config = { ALTER_FEISHU_APP_ID: "cli_test", ALTER_FEISHU_APP_SECRET: "offline-credential" };
  const token = "offline-tenant-token";
  const fetchToken = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ code: 0, tenant_access_token: token }));
  const socket = vi.spyOn(WSClient.prototype, "getConnectionStatus").mockReturnValue({ state: "connecting", reconnectAttempts: 0 });
  try {
    const app = feishuInstance(config, dir, () => {}, {});
    const initial = await app.status();
    expect(initial.state).toBe("connecting");
    expect(initial.checks?.map(c => [c.id, c.ok])).toEqual([["credentials", true], ["connection", false], ["pairing", false], ["account", false]]);
    const [url, options] = fetchToken.mock.calls[0]!;
    expect(String(url)).toContain("/tenant_access_token/internal");
    expect(JSON.parse(String(options?.body))).toMatchObject({ app_id: config.ALTER_FEISHU_APP_ID, app_secret: config.ALTER_FEISHU_APP_SECRET });
    socket.mockReturnValue({ state: "connected", reconnectAttempts: 0 });
    expect((await app.status(false)).state).toBe("needs-config");
    await writeFile(join(dir, "feishu.json"), JSON.stringify({ recent: [], owner: { openId: "u", chatId: "c" } }));
    await writeFile(join(dir, "feishu-user.json"), JSON.stringify({ accessToken: "u", refreshToken: "r", expiresAt: Date.now() + 600_000, refreshAt: Date.now() + 500_000 }));
    const paired = feishuInstance(config, dir, () => {}, {});
    expect(await paired.status()).toMatchObject({ state: "needs-config", detail: expect.stringContaining("重新连接飞书账号"),
      checks: expect.arrayContaining([{ id: "account", label: "用户账号已授权", ok: false, detail: expect.stringContaining("未记录") }]) });
    await writeFile(join(dir, "feishu-user.json"), JSON.stringify({ accessToken: "u", refreshToken: "r", scopes,
      expiresAt: Date.now() + 600_000, refreshAt: Date.now() + 500_000 }));
    expect((await feishuInstance(config, dir, () => {}, {}).status()).state).toBe("ok");
    fetchToken.mockImplementationOnce(async () => Response.json({ code: 10014, msg: config.ALTER_FEISHU_APP_SECRET }));
    const failure = await paired.status();
    expect(failure.state).toBe("error");
    expect(failure.detail).toContain("10014");
    expect(JSON.stringify([initial, failure])).not.toContain(token);
    expect(JSON.stringify(failure)).not.toContain(config.ALTER_FEISHU_APP_SECRET);
    const switched = feishuInstance({ ...config, ALTER_FEISHU_APP_ID: "another" }, dir, () => {}, config);
    expect((await switched.status()).checks?.slice(-2).map(c => c.ok)).toEqual([false, false]);
  } finally { vi.restoreAllMocks(); await rm(dir, { force: true, recursive: true }); }
});
