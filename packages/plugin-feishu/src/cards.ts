import { createHash } from "node:crypto";
import { answerUserPermission, choices, isApprovalDecision, context, conversationDoc, type AlterApp, type PermissionRequest } from "@alter/core";
import type { openState } from "./state.ts";
import type { FeishuHandlers, FeishuTransport } from "./transport.ts";

type Receipt = { messageId: string; status?: "已批准" | "已拒绝" };
const Cards = conversationDoc<{ byId: Record<string, Receipt> }>("feishu-cards", () => ({ byId: {} }));
const plain = (content: string) => ({ tag: "plain_text", content });
function card(request: PermissionRequest) {
  const args = JSON.stringify(request.arguments);
  const summary = args.length > 500 ? args.slice(0, 499) + "…" : args;
  const labels = { once: "允许这一次", statement: "按说明允许", "task-full": "本任务全权限（含不可逆）", deny: "拒绝" };
  const items = request.statement?.map(item => `${item.isNew ? "【新增】" : ""}${item.tool} · ${item.target} · ${item.purpose}`) ?? [];
  return {
    config: { update_multi: true },
    header: { title: plain(`审批 · ${request.tool}`) },
    elements: [
      { tag: "div", text: plain(`任务 ${request.taskId}\n${summary}${items.length ? "\n" + items.join("\n") : ""}`) },
      { tag: "action", actions: choices.filter(choice => request.taskId !== "main" || choice === "once" || choice === "deny").map(decision => ({
        tag: "button", type: decision === "deny" ? "danger" : "default", text: plain(labels[decision]), value: { requestId: request.id, decision },
      })) },
    ],
  };
}

export function approvalCards(app: AlterApp, store: ReturnType<typeof openState>, transport: FeishuTransport) {
  let pending = new Map<string, PermissionRequest>();
  const receipts = async () => (await app.harness.snapshot(Cards, app.main.id, context))?.byId ?? {};
  let running: Promise<void> | undefined;
  let retry: NodeJS.Timeout | undefined;
  let dirty = false;
  let closed = false;

  function failed(operation: string, id: string, error: unknown) {
    console.warn(`Alter Feishu card ${operation} failed for ${id}:`, error instanceof Error ? error.message : "unknown error");
    if (!closed) retry ??= setTimeout(() => { retry = undefined; schedule(); }, 5000).unref();
  }
  async function reconcile() {
    const owner = store.value.owner;
    if (!owner) return;
    const visible = pending;
    const sent = await receipts();
    for (const request of visible.values()) {
      if (sent[request.id] || !pending.has(request.id)) continue;
      // Feishu's create UUID covers a retry between remote acceptance and the local commit.
      const uuid = createHash("sha256").update(owner.chatId + "/" + request.id).digest("hex").slice(0, 32);
      try {
        const messageId = await transport.sendCard(owner.chatId, card(request), uuid);
        await app.main.commit(async tx => { (await tx.doc(Cards, app.main.id)).byId[request.id] = { messageId }; }, context);
      } catch (error) { failed("send", request.id, error); }
    }
    for (const [id, receipt] of Object.entries(sent)) {
      if (visible.has(id)) continue;
      const status = receipt.status ?? "已在其他入口处理";
      try {
        await transport.updateCard(receipt.messageId, { config: { update_multi: true }, elements: [{ tag: "div", text: plain(status) }] });
        await app.main.commit(async tx => { delete (await tx.doc(Cards, app.main.id)).byId[id]; }, context);
      } catch (error) { failed("update", id, error); }
    }
  }
  function schedule() {
    if (closed) return;
    dirty = true;
    if (running) return;
    running = Promise.resolve().then(async () => {
      while (dirty && !closed) {
        dirty = false;
        try { await reconcile(); } catch (error) { failed("sync", "pending", error); }
      }
    }).finally(() => { running = undefined; if (dirty && !closed) schedule(); });
  }
  const action: FeishuHandlers["action"] = async ({ openId, messageId, requestId, decision }) => {
    if (!openId || openId !== store.value.owner?.openId) return { toast: { type: "error", content: "只有主人可以审批" } };
    const sent = await receipts();
    const receipt = requestId && Object.hasOwn(sent, requestId) ? sent[requestId] : undefined;
    if (!requestId || !receipt || receipt.messageId !== messageId || !isApprovalDecision(decision) || receipt.status) {
      return { toast: { type: "info", content: "没有可处理的审批" } };
    }
    const status = decision === "deny" ? "已拒绝" : "已批准";
    const result = await answerUserPermission(app.main, { requestId, decision }, async tx => {
      (await tx.doc(Cards, app.main.id)).byId[requestId] = { ...receipt, status };
    });
    if (result.isError || result.output[0]?.text !== "delivered") return { toast: { type: "info", content: "没有可处理的审批" } };
    return { toast: { type: "success", content: status } };
  };
  return {
    action, schedule,
    update(requests: PermissionRequest[]) {
      pending = new Map(requests.filter(req => req.audience === "user").map(req => [req.id, req]));
      schedule();
    },
    async close() { closed = true; clearTimeout(retry); await running; },
  };
}
