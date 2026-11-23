import { activeWake } from "./wake.ts";
import { activeLease, LeaseHistory, Leases, leaseTarget } from "./leases.ts";
import { interacted } from "./feedback-settings.ts";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import type { ApprovalCall, ApprovalContext, Judgment } from "./approval-model.ts";
import type { ApprovalMode } from "./settings.ts";
import { permitsBorrow, type CapabilityRegistry, type Effect, type ToolAction } from "./capabilities.ts";
import {
  context, conversationDoc, defineExtension, defineSignal, defineTask, hook, reply, ToolTask,
  type Conversation, type ConversationId, type TaskId, type Tx,
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
  borrower?: string; decision: "park" | "allow" | "deny"; at: number; audience?: "user"; tainted?: true;
};
export type PermissionState = { pending: Record<string, Request> };
export const Requests = conversationDoc<PermissionState>("permissions", () => ({ pending: {} }));
export const Audit = conversationDoc<{ entries: AuditEntry[]; last: Record<string, AuditEntry["decision"]>; refused?: Record<string, true> }>(
  "audit", () => ({ entries: [], last: {}, refused: {} }),
);
export type Review = {
  taskId?: string; tool?: string; ended?: "deferred" | "expired"; itemCount?: number; judgment?: Judgment; user?: ApprovalDecision; note?: string;
  userAt?: number; judgedAt?: number; judgeAllowedAt?: number; timeoutAt?: number; expiredAt?: number;
};
export const Reviews = conversationDoc<{ byId: Record<string, Review> }>("approval-reviews", () => ({ byId: {} }));

export function shadowAgreement(reviews: readonly Review[]) {
  let compared = 0, agreed = 0, deniedButInScope = 0;
  for (const { judgment, user } of reviews) {
    if (!judgment || !user) continue;
    compared++;
    if (judgment.inScope === (user !== "deny")) agreed++;
    else if (user === "deny") deniedButInScope++;
  }
  return { compared, agreed, agreementRate: compared ? agreed / compared : null, deniedButInScope };
}

export async function approvalStats(main: Conversation) {
  return main.commit(async tx => shadowAgreement(Object.values((await tx.doc(Reviews, main.id)).byId)), context);
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
    byId[requestId] = { ...byId[requestId], taskId: req.taskId, tool: req.tool, user: decision, userAt: now, ...(note && { note }) };
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
    await interacted(tx, now);
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

async function expire(tx: Tx, main: Conversation, req: Request, at: number) {
  const { byId } = await tx.doc(Reviews, main.id);
  byId[req.id] = { ...byId[req.id], taskId: req.taskId, tool: req.tool, ended: "expired", expiredAt: at };
  delete (await tx.doc(Requests, main.id)).pending[req.id];
}

export function createBroker(getMain: () => Conversation, registry: CapabilityRegistry, timeout: number, defaultMs: number,
  mode: () => ApprovalMode, judge: (statement: PermissionItem[], call: ApprovalCall, owner: { taskId?: string; wakeId?: string }, context?: ApprovalContext) => Promise<Judgment>) {
  const review = defineTask<{ id: string; conversationId?: ConversationId; taskId?: string; wakeId?: string; toolTask: TaskId; statement: PermissionItem[]; tool: string; argumentsJson: string },
    { phase: "review" }, null>({
    name: "alter.approval-review", version: 1, initial: () => ({ phase: "review" }),
    phases: { async review({ input }, api, ctx) {
      const main = getMain();
      const call = { tool: input.tool, arguments: JSON.parse(input.argumentsJson) };
      const { conversationId } = input;
      const metadata = conversationId === undefined ? undefined : await registry.describe(call, {
        conversationId, snapshot: doc => api.snapshot(doc, conversationId, ctx),
      });
      const judgment = await judge(input.statement, call, { taskId: input.taskId, wakeId: input.wakeId }, metadata);
      await api.commit(async tx => {
        const reviews = await tx.doc(Reviews, main.id);
        reviews.byId[input.id] = { ...reviews.byId[input.id], judgment, judgedAt: api.now() };
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
      if (req) await expire(tx, main, req, api.now());
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
        const control = call.name === "finish" || call.name === "sleep" || call.name === "declare_permissions";
        const target = isMain && call.name === "enable_tool" && typeof call.arguments.reason === "string" && call.arguments.reason.trim()
          ? leaseTarget(registry, call.arguments.capability, call.arguments.action) : undefined;
        const descriptor: ToolAction | undefined = target ? { capability: target.capability, action: "lease", effect: target.effect }
          : control ? { capability: "task", action: call.name, effect: "write-local" }
          : isMain && call.name === "notify" ? { capability: "notifications", action: "notify", effect: "write-local" }
          : registry.toolActions.get(call.name);
        const borrowed = call.parent && /^ext:([a-z0-9-]+):(read|write-local|external-send|irreversible):\d+$/.exec(call.id.slice(call.parent.callId.length + 1));
        const borrower = borrowed?.[1];
        if (isMain && !descriptor && !borrower) return;
        const identity = isMain ? undefined : await api.snapshot(TaskIdentity, api.conversationId, ctx);
        const taskId = isMain ? "main" : identity?.taskId ?? "";
        const id = `permission-${api.taskId}`;
        const signal = await api.readSignal(Decision, id, ctx);
        const { capability, action, effect } = descriptor ?? { capability: "unknown", action: call.name, effect: "unknown" };
        return main.commit(async tx => {
          const task = (await tx.doc(Tasks, main.id)).byId[taskId];
          const risky = effect === "external-send" || effect === "irreversible" || effect === "unknown";
          const leasedCall = isMain && !target && registry.toolActions.has(call.name) && capability !== "memory" && capability !== "schedule";
          const leases = leasedCall ? await tx.doc(Leases, main.id) : undefined;
          const key = leases && activeLease(leases.lastUsed, capability, action);
          if (leases && !key) return { block: "No active lease" };
          const leaseId = key && leases?.records?.[key];
          const history = leaseId ? await tx.doc(LeaseHistory, main.id) : undefined;
          const lease = leaseId ? history?.byId[leaseId] : undefined;
          const wake = lease ? await activeWake(tx, main.id, api.now()) : undefined;
          const state = risky || descriptor?.guarded || ((target || leasedCall) && effect !== "read") ? await tx.doc(Taint, api.conversationId) : undefined;
          const taint = state?.first;
          const audit = await tx.doc(Audit, main.id);
          const { pending } = await tx.doc(Requests, main.id);
          const at = api.now();
          function record(decision: AuditEntry["decision"]) {
            if (audit.last[id] === decision) return;
            audit.entries.push({ taskId, tool: call.name, capability, action, effect, decision, at, ...(borrower && { borrower }),
              ...(decision === "park" && { audience: "user" as const }), ...(taint && { tainted: true as const }) });
            audit.last[id] = decision;
            if (decision === "allow" && key && leases) {
              leases.lastUsed[key] = leases.turns + 1;
              if (lease && leaseId && history) {
                lease.calls++;
                if (wake && !lease.useWakeIds.includes(wake.wakeId)) lease.useWakeIds.push(wake.wakeId);
                history.inFlight[id] = leaseId;
              }
            }
          }
          function block(message: string) { record("deny"); return { block: message }; }
          if ((!isMain && task?.status !== "running") || !descriptor) return block("Unknown capability or inactive task");
          if (borrowed && !permitsBorrow(borrowed[2]!, effect)) return block("Borrow exceeds calling effect");
          if (identity?.sourcePlugin && effect !== "read") return block("Message sources can only borrow read tools");
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
          const seen = effect === "read" && url && state?.seen?.includes(url);
          const sensitive = (taint && !seen) || (risky && task && task.permission !== "full");
          if (task?.proactive && sensitive) return block("Proactive research cannot request approval");
          if (req && at >= req.expiresAt) { await expire(tx, main, req, at); return block(expiredMessage); }
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
            const items = lease?.approved ? [{ tool: call.name, target: lease.capability, purpose: lease.reason }] : scope.items;
            const reason = target ? String(call.arguments.reason) : lease?.reason ?? task?.brief ?? "Main session tool call";
            pending[id] = { id, toolTask: api.taskId, taskId, audience: "user", capability, tool: call.name,
              argumentsJson, reason: (borrower ? "插件 " + borrower + " 借用：" : "") + reason, expiresAt: at + timeout,
              statement: items.map((item, index) => ({ ...item, isNew: scope.shown !== undefined && index >= scope.shown })),
              ...(!isMain && { defaultAt: at + Math.min(defaultMs, timeout) }), ...(checking && { checking: true }),
              ...(taint && { tainted: true, taint: { ...taint } }) };
            req = pending[id]!;
            if (setting !== "off" && (eligible || (lease?.approved && effect !== "irreversible" && effect !== "unknown"))) {
              const statement = items.slice(0, scope.approved);
              byId[id] = { taskId, tool: call.name, itemCount: statement.length };
              await tx.createTask(review, { id, taskId, conversationId: api.conversationId, ...(task?.wakeId && { wakeId: task.wakeId }), toolTask: api.taskId, statement,
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
              if (req.checking) result.judgeAllowedAt = at;
              else result.timeoutAt = at;
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
              byId[id] = { ...byId[id], taskId, tool: call.name, ended: "deferred", ...(setting === "auto" && { timeoutAt: at }) };
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
        const untrusted = isUntrusted(result.details);
        const main = getMain();
        if (!untrusted && (api.conversationId !== main.id || (!action && !result.isError))) return;
        try {
          await main.commit(async tx => {
            if (untrusted) recordUntrusted(await tx.doc(Taint, api.conversationId), {
              source: call.name, capability: action?.capability ?? "unknown", at: api.now(),
            }, result.output);
            if (api.conversationId === main.id) {
              const id = `permission-${api.taskId}`;
              const history = await tx.doc(LeaseHistory, main.id);
              const leaseId = history.inFlight[id];
              if (leaseId) {
                history.byId[leaseId]![result.isError ? "failed" : "succeeded"]++;
                delete history.inFlight[id];
              }
              if (result.isError) delete (await tx.doc(Requests, main.id)).pending[id];
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
