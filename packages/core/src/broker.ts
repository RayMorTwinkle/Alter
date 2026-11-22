import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import type { ApprovalCall, Judgment } from "./approval-model.ts";
import type { ApprovalMode } from "./settings.ts";
import type { CapabilityRegistry, Effect, ToolAction } from "./capabilities.ts";
import {
  context, conversationDoc, defineExtension, defineSignal, defineTask, hook, reply, ToolTask,
  type Conversation, type TaskId, type Tx,
} from "./runtime.ts";
import { isUntrusted, normalUrl, recordUntrusted, Taint, type TaintSource } from "./taint.ts";
import { Ledger, ScopeDoc, TaskIdentity, Tasks, type PermissionItem } from "./state.ts";

export const choices = ["once", "statement", "task-full", "deny"] as const;
export type ApprovalDecision = typeof choices[number];
export const isApprovalDecision = (value: unknown): value is ApprovalDecision => choices.some(choice => choice === value);
type Request = {
  id: string; taskId: string; toolTask: TaskId; audience: "main" | "user"; capability: string; tool: string;
  reason: string; argumentsJson: string; expiresAt: number; defaultAt?: number;
  statement?: (PermissionItem & { isNew: boolean })[];
  wakeKey?: string; checking?: true; deferred?: true; tainted?: true; taint?: TaintSource;
};
type AuditEntry = {
  taskId: string; tool: string; capability: string; action: string; effect: Effect;
  decision: "park" | "allow" | "deny"; at: number; audience?: "user"; tainted?: true;
};
export type PermissionState = { pending: Record<string, Request> };
export const Requests = conversationDoc<PermissionState>("permissions", () => ({ pending: {} }));
export const Audit = conversationDoc<{ entries: AuditEntry[]; last: Record<string, AuditEntry["decision"]>; refused?: Record<string, true> }>(
  "audit", () => ({ entries: [], last: {}, refused: {} }),
);
type Review = { ended?: "deferred" | "expired"; itemCount?: number; judgment?: Judgment; user?: ApprovalDecision; note?: string };
const Reviews = conversationDoc<{ byId: Record<string, Review> }>("approval-reviews", () => ({ byId: {} }));
export async function approvalStats(main: Conversation) {
  return main.commit(async tx => {
    let compared = 0, agreed = 0, deniedButInScope = 0;
    for (const { judgment, user } of Object.values((await tx.doc(Reviews, main.id)).byId)) {
      if (!judgment || !user) continue;
      compared++;
      if (judgment.inScope === (user !== "deny")) agreed++;
      else if (user === "deny") deniedButInScope++;
    }
    return { compared, agreed, agreementRate: compared ? agreed / compared : null, deniedButInScope };
  }, context);
}
const Decision = defineSignal({ name: "alter.permission", version: 1, schema: obj({ allow: bool(), note: opt(str()) }) });
const Reviewed = defineSignal({ name: "alter.reviewed", version: 1, schema: bool() });
type Answer = { requestId: string; decision: ApprovalDecision; note?: string };
export const approvalClocks = new WeakMap<Conversation, () => number>();
const expiredMessage = "Approval expired without a decision";
const deferredMessage = "暂未获批，可先做别的，做不下去就 finish 报告";

export function answerUserPermission(main: Conversation, answer: Answer, onDelivered?: (tx: Tx) => Promise<void>) {
  return main.commit(async tx => {
    const { requestId, decision, note } = answer;
    const { pending } = await tx.doc(Requests, main.id);
    const req = Object.hasOwn(pending, requestId) ? pending[requestId] : undefined;
    if (!req || req.audience !== "user" || req.checking || !isApprovalDecision(decision)) return reply("No pending user decision", true);
    const now = (approvalClocks.get(main) ?? Date.now)();
    if (now >= req.expiresAt) return reply(expiredMessage, true);
    const task = (await tx.doc(Tasks, main.id)).byId[req.taskId];
    if (!task && (decision === "statement" || decision === "task-full")) return reply("Task decision requires a task", true);
    if (!req.deferred) {
      const status = await tx.signal(req.toolTask, Decision, req.wakeKey ?? req.id, { allow: decision !== "deny", ...(note && { note }) });
      // At the soft deadline pi-durable closes the signal, but its gate is waking and reads the durable decision.
      if (status !== "delivered" && !(status === "closed" && !req.wakeKey && req.defaultAt && now >= req.defaultAt)) return reply(status, true);
    }
    const { byId } = await tx.doc(Reviews, main.id);
    byId[requestId] = { ...byId[requestId], user: decision, ...(note && { note }) };
    if (task && (await tx.doc(TaskIdentity, task.conversationId)).taskId === req.taskId) {
      const scope = await tx.doc(ScopeDoc, task.conversationId);
      if (decision === "task-full") scope.full = true;
      if (decision === "statement") scope.approved = Math.max(scope.approved ?? 0, req.statement?.length ?? 0);
      if (decision === "deny") {
        const audit = await tx.doc(Audit, main.id);
        audit.refused ??= {};
        audit.refused[`${req.taskId} ${req.tool}`] = true;
      } else if (req.deferred && decision !== "task-full") {
        scope.late.push({ tool: req.tool, argumentsJson: req.argumentsJson });
      }
      if (decision === "task-full" || decision === "deny") {
        for (const other of Object.values(pending)) {
          if (other.id === req.id || other.taskId !== req.taskId || (decision === "deny" && other.tool !== req.tool) || now >= other.expiresAt) continue;
          if (!other.deferred) await tx.signal(other.toolTask, Decision, other.wakeKey ?? other.id, { allow: decision === "task-full" });
          delete pending[other.id];
        }
      }
    }
    delete pending[requestId];
    await onDelivered?.(tx);
    return reply("delivered");
  }, context);
}

export async function migrateRequests(tx: Tx, main: Conversation, at: number, timeout: number) {
  const { pending } = await tx.doc(Requests, main.id);
  for (const req of Object.values(pending)) {
    if (req.audience === "main" || req.tool === "request_capability") {
      await tx.signal(req.toolTask, Decision, req.id, { allow: false });
      delete pending[req.id];
    } else {
      req.expiresAt ??= at + timeout;
      req.statement ??= [];
    }
  }
}

async function expire(tx: Tx, main: Conversation, req: Request) {
  const { byId } = await tx.doc(Reviews, main.id);
  byId[req.id] = { ...byId[req.id], ended: "expired" };
  delete (await tx.doc(Requests, main.id)).pending[req.id];
  await main.submit(tx, { type: "input", whenBusy: "followUp", requestId: `expired-${req.id}`,
    content: `Notify the user: task ${req.taskId}, request ${req.id} (${req.tool}): Approval expired without a decision` });
}

export function createBroker(getMain: () => Conversation, registry: CapabilityRegistry, timeout: number, defaultMs: number,
  mode: () => ApprovalMode, judge: (statement: PermissionItem[], call: ApprovalCall) => Promise<Judgment>) {
  const review = defineTask<{ id: string; toolTask: TaskId; statement: PermissionItem[]; tool: string; argumentsJson: string },
    { phase: "review" }, null>({
    name: "alter.approval-review", version: 1, initial: () => ({ phase: "review" }),
    phases: { async review({ input }, api, ctx) {
      const main = getMain();
      const judgment = await judge(input.statement, { tool: input.tool, arguments: JSON.parse(input.argumentsJson) });
      await api.commit(async tx => {
        const reviews = await tx.doc(Reviews, main.id);
        reviews.byId[input.id] = { ...reviews.byId[input.id], judgment };
        await tx.signal(input.toolTask, Reviewed, input.id, true);
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, ctx);
    } },
    abort: (_, api, ctx) => api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  const expiry = defineTask<{ id: string }, { phase: "expire" }, null>({
    name: "alter.deferred-expiry", version: 1, initial: () => ({ phase: "expire" }),
    phases: { expire: ({ input }, api, ctx) => api.commit(async tx => {
      const main = getMain();
      const req = (await tx.doc(Requests, main.id)).pending[input.id];
      if (req && api.now() < req.expiresAt) return { status: "sleeping", checkpoint: { phase: "expire" }, until: req.expiresAt };
      if (req) await expire(tx, main, req);
      return { status: "terminal", outcome: { status: "completed", result: null } };
    }, ctx) },
    abort: (_, api, ctx) => api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  return defineExtension({
    name: "alter.broker", tasks: [review, expiry],
    hooks: [hook(ToolTask, {
      async beforeTool(call, api, ctx) {
        const main = getMain();
        const isMain = api.conversationId === main.id;
        const control = call.name === "finish" || call.name === "declare_permissions";
        const descriptor: ToolAction | undefined = control ? { capability: "task", action: call.name, effect: "write-local" }
          : registry.toolActions.get(call.name);
        if (isMain && !descriptor) return;
        const taskId = isMain ? "main" : (await api.snapshot(TaskIdentity, api.conversationId, ctx))?.taskId ?? "";
        const id = `permission-${api.taskId}`;
        const signal = await api.readSignal(Decision, id, ctx);
        const { capability, action, effect } = descriptor ?? { capability: "unknown", action: call.name, effect: "unknown" };
        return main.commit(async tx => {
          const task = (await tx.doc(Tasks, main.id)).byId[taskId];
          const risky = effect === "external-send" || effect === "irreversible" || effect === "unknown";
          const state = risky || descriptor?.guarded ? await tx.doc(Taint, api.conversationId) : undefined;
          const taint = state?.first;
          const audit = await tx.doc(Audit, main.id);
          const { pending } = await tx.doc(Requests, main.id);
          const at = api.now();
          function record(decision: AuditEntry["decision"]) {
            if (audit.last[id] === decision) return;
            audit.entries.push({ taskId, tool: call.name, capability, action, effect, decision, at,
              ...(decision === "park" && { audience: "user" as const }), ...(taint && { tainted: true as const }) });
            audit.last[id] = decision;
          }
          function block(message: string) { record("deny"); return { block: message }; }
          if ((!isMain && task?.status !== "running") || !descriptor) return block("Unknown capability or inactive task");
          if (task?.proactive && !control && (effect !== "read" || capability !== "browser")) return block("Proactive research is read-only");
          const { byId } = await tx.doc(Reviews, main.id);
          const result = byId[id];
          if (result?.ended) return block(result.ended === "expired" ? expiredMessage : deferredMessage);
          let req = pending[id];
          const legacy = req && signal && "value" in signal ? signal.value : undefined;
          const user = result?.user ?? (legacy && (legacy.allow ? "once" : "deny"));
          if (user) {
            delete pending[id];
            if (user === "deny") {
              if (legacy && !isMain) {
                audit.refused ??= {};
                audit.refused[`${taskId} ${call.name}`] = true;
              }
              return block(`The user declined this ${call.name} call. ${result?.note ?? legacy?.note ?? ""} Do not retry it; finish and report that it was declined.`);
            }
            record("allow");
            return;
          }
          if (!isMain && audit.refused?.[`${taskId} ${call.name}`]) {
            delete pending[id];
            return block(`The user already declined ${call.name} in this task. Do not retry it; finish and report that the user declined.`);
          }
          const value = descriptor.seenArg && call.arguments[descriptor.seenArg];
          const url = typeof value === "string" ? normalUrl(value) : undefined;
          const seen = !risky && url && state?.seen?.includes(url);
          const sensitive = (taint && !seen) || (risky && task && task.permission !== "full");
          if (task?.proactive && sensitive) return block("Proactive research cannot request approval");
          if (req && at >= req.expiresAt) { await expire(tx, main, req); return block(expiredMessage); }
          const scope = await tx.doc(ScopeDoc, api.conversationId);
          const argumentsJson = JSON.stringify(call.arguments, (_, value) =>
            value && typeof value === "object" && !Array.isArray(value)
              ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
          if ((!sensitive && !req) || scope.full || audit.last[id] === "allow") { delete pending[id]; record("allow"); return; }
          const late = scope.late.findIndex(item => item.tool === call.name && item.argumentsJson === argumentsJson);
          if (late >= 0) { scope.late.splice(late, 1); delete pending[id]; record("allow"); return; }
          const setting = mode();
          const eligible = !isMain && effect !== "irreversible" && effect !== "unknown";
          if (!req) {
            if (Object.values(pending).some(r => r.taskId === taskId && r.deferred && r.tool === call.name &&
              r.argumentsJson === argumentsJson && r.expiresAt > at)) return block(deferredMessage);
            const checking = eligible && setting === "auto" && scope.approved !== undefined;
            pending[id] = { id, toolTask: api.taskId, taskId, audience: "user", capability, tool: call.name,
              argumentsJson, reason: task?.brief ?? "Main session tool call", expiresAt: at + timeout,
              statement: scope.items.map((item, index) => ({ ...item, isNew: scope.shown !== undefined && index >= scope.shown })),
              ...(!isMain && { defaultAt: at + Math.min(defaultMs, timeout) }), ...(checking && { checking: true }),
              ...(taint && { tainted: true, taint: { ...taint } }) };
            req = pending[id]!;
            if (eligible && setting !== "off") {
              const statement = scope.items.slice(0, scope.approved);
              byId[id] = { itemCount: statement.length };
              await tx.createTask(review, { id, toolTask: api.taskId, statement,
                tool: call.name, argumentsJson }, { ownership: { kind: "conversation" }, background: true });
            }
            if (!checking) { scope.shown = scope.items.length; record("park"); }
          }
          const due = req.defaultAt !== undefined && at >= req.defaultAt;
          if (setting === "auto" && eligible && (req.checking || due)) {
            if (byId[id]?.itemCount !== undefined && !result?.judgment) {
              req.wakeKey = id + "-review";
              return { sleep: { until: req.expiresAt, signals: [Reviewed.key(id), Decision.key(req.wakeKey)] } };
            }
            if (result?.judgment?.inScope && result.itemCount) {
              scope.approved ??= req.statement?.length ?? 0;
              delete pending[id];
              record("allow");
              (await tx.doc(Ledger, main.id)).entries.push({ taskId, at, summary: `审批模型放行：${call.name}（${result.judgment.reason}）`,
                refs: [{ kind: "approval", ref: id }] });
              return;
            }
          }
          if (req.checking) {
            delete req.checking;
            req.defaultAt = Math.min(at + defaultMs, req.expiresAt);
            scope.shown = req.statement?.length ?? 0;
            record("park");
          }
          const defaultReached = req.defaultAt !== undefined && at >= req.defaultAt;
          if (defaultReached && setting !== "shadow") {
            if (setting === "auto") scope.approved ??= req.statement?.length ?? 0;
            if (!req.deferred) {
              req.deferred = true;
              byId[id] = { ...byId[id], ended: "deferred" };
              await tx.createTask(expiry, { id }, { ownership: { kind: "conversation" }, background: true });
            }
            return block(deferredMessage);
          }
          const until = defaultReached ? req.expiresAt : req.defaultAt ?? req.expiresAt;
          if (defaultReached) req.wakeKey = id + "-final";
          else delete req.wakeKey;
          return { sleep: { until, signals: [Decision.key(req.wakeKey ?? id)] } };
        }, ctx);
      },
      async afterTool(call, result, api, ctx) {
        const action = registry.toolActions.get(call.name);
        if (!action) return;
        const untrusted = isUntrusted(result.details);
        const main = getMain();
        if (!untrusted && !(api.conversationId === main.id && result.isError)) return;
        try {
          await main.commit(async tx => {
            if (untrusted) recordUntrusted(await tx.doc(Taint, api.conversationId), {
              source: call.name, capability: action.capability, at: api.now(),
            }, result.output);
            // A stopped main turn has no background-task owner to clear its parked lease call.
            if (api.conversationId === main.id && result.isError) {
              delete (await tx.doc(Requests, main.id)).pending[`permission-${api.taskId}`];
            }
          }, ctx);
        } catch (error) {
          // pi-durable logs afterTool exceptions and keeps the original result. Withhold untracked content.
          if (untrusted) return reply("External content withheld because its source could not be recorded", true);
          throw error;
        }
      },
    })],
  });
}
