import { randomInt } from "node:crypto";
import { Events, context, observeSurface, submitMessage, type AlterApp, type AlterSurface } from "@alter/core";
import { approvalCards } from "./cards.ts";
import type { FeishuConfig } from "./config.ts";
import { openState } from "./state.ts";
import { sdkTransport, type FeishuMessage, type FeishuTransport } from "./transport.ts";

export { createFeishuConnector } from "./connector.ts";
export type { FeishuAccount } from "./account.ts";
export { feishuConfigFromEnv, type FeishuConfig } from "./config.ts";
export type { FeishuHandlers, FeishuMessage, FeishuTransport } from "./transport.ts";
export type FeishuPairing = { paired: true } | { paired: false; code: string; expiresAt: number };
type Options = { dataDir: string; now?: () => number } & ({ transport: FeishuTransport } | { config: FeishuConfig });
const lifetime = 10 * 60_000;

export function createFeishuSurface(options: Options): AlterSurface & { pairing(): FeishuPairing } {
  const store = openState(options.dataDir);
  const now = options.now ?? Date.now;
  const attempts = new Map<string, number>();
  let challenge: { code: string; expiresAt: number } | undefined;
  let timer: NodeJS.Timeout | undefined;
  function pairing(): FeishuPairing {
    if (store.value.owner) return { paired: true };
    if (!challenge || challenge.expiresAt <= now()) {
      let code: string;
      do { code = String(randomInt(1_000_000)).padStart(6, "0"); } while (code === challenge?.code);
      challenge = { code, expiresAt: now() + lifetime };
      attempts.clear();
      clearTimeout(timer);
      timer = setTimeout(pairing, lifetime).unref();
      console.log(`Alter Feishu 配对码 ${code}（10 分钟有效）`);
    }
    return { paired: false, ...challenge };
  }
  async function start(app: AlterApp) {
    // A crash after committing an event can precede the receipt file's rename.
    const recorded = new Set((await app.harness.snapshot(Events, app.main.id, context))?.entries
      .filter(event => event.source === "feishu" && event.kind === "message").map(event => event.ref));
    const transport = "transport" in options ? options.transport : sdkTransport(options.config);
    const cards = approvalCards(app, store, transport);
    async function receive(message: FeishuMessage) {
      const { id, chatId, chatType, openId, text } = message;
      if (!id || store.value.recent.includes(id)) return;
      if (recorded.has(id)) {
        store.remember(id);
        recorded.delete(id);
        return;
      }
      const owner = store.value.owner;
      const privateUser = openId && chatId && chatType === "p2p";
      if (!owner && privateUser && message.type === "text") {
        const status = pairing();
        const failures = attempts.get(openId) ?? 0;
        if (!status.paired && failures < 5 && text === status.code) {
          store.remember(id, { openId, chatId });
          clearTimeout(timer);
          challenge = undefined;
          attempts.clear();
          cards.schedule();
          await transport.sendText(chatId, "配对成功");
          return;
        }
        attempts.set(openId, Math.min(5, failures + 1));
      }
      if (privateUser && owner?.openId === openId) {
        if (message.type !== "text") await transport.sendText(owner.chatId, "目前只支持文字");
        else if (text) await submitMessage(app.main, text, "feishu", `feishu-${id}`);
      } else {
        await app.events.emit({ source: "feishu", kind: "message", ref: id, at: message.at, untrusted: true,
          summary: (text || `[${message.type}]`).slice(0, 512) });
        recorded.add(id);
      }
      store.remember(id);
      recorded.delete(id);
    }
    let inbox = Promise.resolve();
    let outbox = Promise.resolve();
    const actions = new Set<Promise<unknown>>();
    let stopped = false;
    let observation: Awaited<ReturnType<typeof observeSurface>> | undefined;
    const observe = () => observeSurface(app, (event, source) => {
      if (event.event === "pending") cards.update(event.data);
      if (event.event !== "timeline" || event.data.kind !== "assistant" || source !== "feishu") return;
      const chatId = store.value.owner?.chatId;
      const { text } = event.data;
      if (chatId && text.trim()) outbox = outbox.then(() => transport.sendText(chatId, text)).catch((error: unknown) => {
        console.warn("Alter Feishu reply delivery failed:", error instanceof Error ? error.message : "unknown error");
      });
    });
    async function stop() {
      stopped = true;
      observation?.detach();
      clearTimeout(timer);
      try {
        await transport.close();
      } finally {
        await Promise.allSettled([inbox, outbox, ...actions]);
        await cards.close();
      }
    }
    try {
      observation = await observe();
      pairing();
      await transport.start({
        message(message) {
          if (stopped) return Promise.resolve();
          const next = inbox.then(() => receive(message));
          inbox = next.catch(() => {});
          return next;
        },
        async action(action) {
          if (stopped) return { toast: { type: "error", content: "服务已关闭" } };
          const result = cards.action(action);
          actions.add(result);
          try { return await result; } finally { actions.delete(result); }
        },
      });
    } catch (error) { await stop(); throw error; }
    return stop;
  }
  return { id: "feishu", start, pairing };
}
