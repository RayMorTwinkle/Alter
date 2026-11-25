import { createHash } from "node:crypto";
import { FeedbackError, type IssuedFeedback, updateNotification, answerUserPermission, choices, isApprovalDecision, context, conversationDoc, type AlterApp, type PermissionRequest } from "@alter/core";
import type { openState } from "./state.ts";
import type { FeishuHandlers, FeishuTransport } from "./transport.ts";

type Receipt = { messageId: string; status?: "已批准" | "已拒绝"; settled?: string };
const Cards = conversationDoc<{ byId: Record<string, Receipt> }>("feishu-cards", () => ({ byId: {} }));
const plain = (content: string) => ({ tag: "plain_text", content });
function card(request: PermissionRequest) {
  const args = JSON.stringify(request.arguments);
  const summary = args.length > 500 ? args.slice(0, 499) + "…" : args;
  const labels = { once: "允许这一次", capability: `本次允许${request.capability}全部功能`, always: `始终允许${request.capability}全部功能`, deny: "拒绝" };
  const items = request.statement?.map(item => `${item.isNew ? "【新增】" : ""}${[item.tool, item.target, item.purpose].filter(Boolean).join(" · ")}`) ?? [];
  return {
    config: { update_multi: true },
    header: { title: plain(`审批 · ${request.tool}`) },
    elements: [
      { tag: "div", text: plain(`任务 ${request.taskId}\n${summary}${items.length ? "\n" + items.join("\n") : ""}`) },
      { tag: "action", actions: choices.map(decision => ({
        tag: "button", type: decision === "deny" ? "danger" : "default", text: plain(labels[decision]), value: { requestId: request.id, decision },
      })) },
    ],
  };
}

function feedbackButton(id: string, operation: "answer" | "skip" | "more", label: string) {
  return { tag: "button", text: plain(label), type: operation === "answer" ? "primary" : "default",
    ...(operation === "answer" && { name: "answer", form_action_type: "submit" }),
    behaviors: [{ type: "callback", value: { feedbackId: id, operation } }] };
}
function feedbackCard(q: IssuedFeedback) {
  const more = q.moreUsed ? [] : [feedbackButton(q.id, "more", "再来几题")];
  let elements: object[];
  if (q.status === "pending") {
    elements = [
      { tag: "div", text: plain(q.prompt + "\n" + q.why) },
      { tag: "form", name: "feedback", elements: [
        { tag: q.multi ? "multi_select_static" : "select_static", name: "options", placeholder: plain(q.multi ? "可多选" : "请选择"),
          options: q.options.map(value => ({ text: plain(value), value })) },
        ...(q.allowOther ? [{ tag: "input", name: "other",
          placeholder: plain("其他（选填）") }] : []),
        feedbackButton(q.id, "answer", "提交"),
      ] },
      feedbackButton(q.id, "skip", "跳过"), ...more,
    ];
  } else {
    const label = { answered: "已回答", skipped: "已跳过", expired: "题目已更新", applying: "正在保存" }[q.status];
    elements = [{ tag: "div", text: plain(q.prompt + " · " + label) }, ...more];
  }
  return { schema: "2.0", config: { update_multi: true }, header: { title: plain("Alter 回访") }, body: { elements } };
}

export function approvalCards(app: AlterApp, store: ReturnType<typeof openState>, transport: FeishuTransport) {
  let pending = new Map<string, PermissionRequest>();
  let questions = new Map<string, IssuedFeedback>();
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
    const unsent = [...questions.values()].filter(q => !sent[q.id] && q.status === "pending" && app.now() - q.askedAt < 7 * 86400_000);
    const feedback = unsent.length && await app.feedback.active() ? unsent : [];
    const pendingCards = [
      ...[...visible.values()].map(r => ({ id: r.id, content: card(r) })),
      ...feedback.map(q => ({ id: q.id, content: feedbackCard(q) })),
    ];
    for (const request of pendingCards) {
      if (sent[request.id] || (!pending.has(request.id) && questions.get(request.id)?.status !== "pending")) continue;
      // Feishu's create UUID covers a retry between remote acceptance and the local commit.
      const uuid = createHash("sha256").update(owner.chatId + "/" + request.id).digest("hex").slice(0, 32);
      try {
        const messageId = await transport.sendCard(owner.chatId, request.content, uuid);
        await app.main.commit(async tx => { (await tx.doc(Cards, app.main.id)).byId[request.id] = { messageId }; }, context);
        const question = questions.get(request.id);
        if (question?.outlet === "checkin") await updateNotification(app.main, question.batch, { pushedAt: app.now() });
      } catch (error) { failed("send", request.id, error); }
    }
    for (const [id, receipt] of Object.entries(sent)) {
      if (visible.has(id)) continue;
      const q = questions.get(id);
      if (q) {
        const version = q.status + "/" + Boolean(q.moreUsed);
        if (app.now() - q.askedAt >= 14 * 86400_000 || q.status === "applying" || receipt.settled === version || (q.status === "pending" && !q.moreUsed)) continue;
        try {
          await transport.updateCard(receipt.messageId, feedbackCard(q));
          await app.main.commit(async tx => { (await tx.doc(Cards, app.main.id)).byId[id]!.settled = version; }, context);
        } catch (error) { failed("update", id, error); }
        continue;
      }
      // A feedback card whose question has left the bank is a schema 2.0 card; Feishu refuses to downgrade it.
      const approval = id.startsWith("permission-");
      const elements = [{ tag: "div", text: plain(receipt.status ?? (approval ? "已在其他入口处理" : "题目已更新")) }];
      try {
        await transport.updateCard(receipt.messageId, approval ? { config: { update_multi: true }, elements }
          : { schema: "2.0", config: { update_multi: true }, header: { title: plain("Alter 回访") }, body: { elements } });
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
  const action: FeishuHandlers["action"] = async ({ openId, messageId, requestId, decision, feedbackId, operation, form }) => {
    if (!openId || openId !== store.value.owner?.openId) return { toast: { type: "error", content: "只有主人可以审批" } };
    const sent = await receipts();
    if (feedbackId && operation) {
      if (!Object.hasOwn(sent, feedbackId) || sent[feedbackId]?.messageId !== messageId) return { toast: { type: "error", content: "回访卡片不匹配" } };
      try {
        if (operation === "more") {
          const next = await app.feedback.more(feedbackId);
          return { toast: { type: "success", content: next.length ? "已取下一组" : "暂时没有更多问题" } };
        }
        if (operation === "skip") await app.feedback.skip(feedbackId);
        else {
          const options = form?.options;
          await app.feedback.answer(feedbackId, { options: typeof options === "string" ? (options ? [options] : []) : options ?? [],
            ...(form?.other !== undefined && form.other !== "" && { other: form.other }) });
        }
        return { toast: { type: "success", content: operation === "skip" ? "已跳过" : "已回答" } };
      } catch (error) {
        if (error instanceof FeedbackError) return { toast: { type: "info", content: error.message } };
        throw error;
      }
    }
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
    feedback(view: Awaited<ReturnType<AlterApp["feedback"]["view"]>>) {
      questions = new Map([...view.pending, ...view.history].map(q => [q.id, q]));
      schedule();
    },
    update(requests: PermissionRequest[]) {
      pending = new Map(requests.filter(req => req.audience === "user").map(req => [req.id, req]));
      schedule();
    },
    async close() { closed = true; clearTimeout(retry); await running; },
  };
}
