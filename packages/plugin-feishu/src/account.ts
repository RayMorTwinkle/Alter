import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FeishuUserConfig } from "./config.ts";
import type { FeishuUserApi } from "./user-api.ts";

const scopes = ["offline_access", "im:chat:read", "im:message", "im:message.p2p_msg:get_as_user",
  "im:message.group_msg:get_as_user", "im:message.send_as_user"];
type Tokens = { accessToken: string; refreshToken: string; expiresAt: number; refreshAt: number; name?: string };

export function openAccount(config: FeishuUserConfig, dataDir: string, api: FeishuUserApi, now: () => number) {
  const path = join(dataDir, "feishu-user.json");
  const states = new Map<string, { expiresAt: number; verifier: string }>();
  let tokens: Tokens | undefined;
  try {
    tokens = JSON.parse(readFileSync(path, "utf8"));
    if (!tokens || typeof tokens.accessToken !== "string" || !tokens.accessToken || typeof tokens.refreshToken !== "string"
      || !tokens.refreshToken || !Number.isFinite(tokens.expiresAt) || !Number.isFinite(tokens.refreshAt)) throw new Error("Invalid feishu-user.json");
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Invalid feishu-user.json");
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // A refresh token can only be used once. Order all token transitions, including disconnect.
  let pending = Promise.resolve();
  function ordered<T>(fn: () => T | Promise<T>) {
    const result = pending.then(fn);
    pending = result.then(() => {}, () => {});
    return result;
  }
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  function schedule() {
    clearTimeout(timer);
    if (running && tokens) {
      timer = setTimeout(() => {
        void current().then(schedule, () => console.error("Feishu account refresh could not update local storage"));
      }, Math.max(0, Math.min(2 ** 31 - 1, tokens.refreshAt - now()))).unref();
    }
  }
  function clear() {
    rmSync(path, { force: true });
    tokens = undefined;
    clearTimeout(timer);
  }
  function save(result: Awaited<ReturnType<FeishuUserApi["exchange"]>>, name?: string) {
    const { accessToken, refreshToken, expiresIn } = result;
    if (!accessToken || !refreshToken || !expiresIn || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("Incomplete Feishu token response");
    }
    const expiresAt = now() + expiresIn * 1000;
    const next = { accessToken, refreshToken, expiresAt, refreshAt: expiresAt - Math.min(60_000, expiresIn * 100), name };
    mkdirSync(dataDir, { mode: 0o700, recursive: true });
    const temp = path + "." + randomUUID();
    try {
      writeFileSync(temp, JSON.stringify(next), { flag: "wx", mode: 0o600 });
      renameSync(temp, path);
      tokens = next;
      schedule();
    } finally { rmSync(temp, { force: true }); }
  }
  function current() {
    return ordered(async () => {
      if (tokens && tokens.refreshAt <= now()) {
        try { save(await api.refresh(tokens.refreshToken), tokens.name); }
        catch { clear(); }
      }
      return tokens;
    });
  }
  return {
    async watch() {
      running = true;
      schedule();
      return async () => { running = false; clearTimeout(timer); await pending; };
    },
    async accessToken() { return (await current())?.accessToken; },
    async status() {
      const value = await current();
      return value ? { connected: true, name: value.name } : { connected: false };
    },
    start() {
      const at = now();
      for (const [key, entry] of states) if (entry.expiresAt <= at) states.delete(key);
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      states.set(state, { expiresAt: at + 600_000, verifier });
      const host = config.domain === "lark" ? "accounts.larksuite.com" : "accounts.feishu.cn";
      const url = new URL(`https://${host}/open-apis/authen/v1/authorize`);
      url.search = new URLSearchParams({ client_id: config.appId, response_type: "code", redirect_uri: config.redirectUri,
        scope: scopes.join(" "), state, code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url") }).toString();
      return url.href;
    },
    async callback(state: string | null, code: string | null) {
      if (!state) return false;
      const entry = states.get(state);
      states.delete(state);
      if (!entry || entry.expiresAt <= now() || !code) return false;
      await ordered(async () => {
        const result = await api.exchange(code, config.redirectUri, entry.verifier);
        const name = await api.name(result.accessToken).catch(() => undefined);
        save(result, name);
      });
      return true;
    },
    disconnect() { states.clear(); return ordered(clear); },
  };
}

export type FeishuAccount = Pick<ReturnType<typeof openAccount>, "status" | "start" | "callback" | "disconnect">;
