import { activeWake } from "./wake.ts";
import { activeLease, holdsLease, LeaseHistory, Leases } from "./leases.ts";
import { interacted } from "./feedback-settings.ts";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import type { ApprovalCall, ApprovalContext, Judgment } from "./approval-model.ts";
import { AllowedCapabilities, type ApprovalMode } from "./settings.ts";
import { normalizeEffect, permitsBorrow, type CapabilityRegistry, type Effect, type ToolAction } from "./capabilities.ts";
import {
  context, conversationDoc, defineExtension, defineSignal, defineTask, hook, reply, ToolTask,
  type Conversation, type ConversationId, type TaskId, type Tx,
} from "./runtime.ts";
import { recentUserText } from "./timeline.ts";
import { Ledger, ScopeDoc, TaskIdentity, Tasks, type PermissionItem, type TaskRecord } from "./state.ts";

export const choices = ["once", "capability", "always", "deny"] as const;
export type ApprovalDecision = typeof choices[number];
export const isApprovalDecision = (value: unknown): value is ApprovalDecision => choices.some(choice => choice === value);
export function parseApprovalDecision(value: unknown) {
  if (value === "task-full") return "capability";
  return isApprovalDecision(value) ? value : undefined;
}
type Request = {
  id: string; taskId: string; toolTask: TaskId; audience: "main" | "user"; capability: string; tool: string;
  reason: string; argumentsJson: string; expiresAt: number; defaultAt?: number;
  statement?: (PermissionItem & { isNew: boolean })[];
  leaseId?: string; wakeKey?: string; checking?: true; deferred?: true;
};
type AuditEntry = {
  taskId: string; tool: string; capability: string; action: string; effect: Effect;
  borrower?: string; decision: "park" | "allow" | "deny"; at: number; audience?: "user";
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

export function approvalCounts(reviews: readonly Review[], askedUser: number, within: (at?: number) => boolean = () => true) {
  const counts = { modelAllowed: 0, askedUser, userApproved: 0, userDenied: 0 };
  for (const review of reviews) {
    if (review.judgeAllowedAt !== undefined && within(review.judgeAllowedAt)) counts.modelAllowed++;
    if (review.user && within(review.userAt)) counts[review.user === "deny" ? "userDenied" : "userApproved"]++;
  }
  return counts;
}

export async function approvalStats(main: Conversation) {
  return main.commit(async tx => {
    const audit = await tx.doc(Audit, main.id);
    const askedUser = audit.entries.filter(e => e.decision === "park" && e.audience === "user").length;
    return approvalCounts(Object.values((await tx.doc(Reviews, main.id)).byId), askedUser);
  }, context);
}
const Decision = defineSignal({ name: "alter.permission", version: 1, schema: obj({ allow: bool(), note: opt(str()) }) });
const Reviewed = defineSignal({ name: "alter.reviewed", version: 1, schema: bool() });
type Answer = { requestId: string; decision: ApprovalDecision; note?: string };
export const approvalClocks = new WeakMap<Conversation, () => number>();
const expiredMessage = "Approval expired without a decision";
const deferredMessage = "暂未获批，可先做别的，做不下去就 finish 报告";

const onceWindow = 10 * 60_000;

async function rememberOnce(tx: Tx, caller: ConversationId, tool: string, clickedAt: number) {
  const scope = await tx.doc(ScopeDoc, caller);
  const expiresAt = clickedAt + onceWindow;
  if (scope.late.some(item => item.tool === tool && item.expiresAt >= expiresAt)) return;
  scope.late = scope.late.filter(item => item.tool !== tool && item.expiresAt > clickedAt);
  scope.late.push({ tool, expiresAt });
}

async function currentCaller(tx: Tx, main: Conversation, taskId: string, task?: TaskRecord) {
  if (taskId === "main") return main.id;
  if (task && (await tx.doc(TaskIdentity, task.conversationId)).taskId === taskId) return task.conversationId;
}

export function answerUserPermission(main: Conversation, answer: Answer, onDelivered?: (tx: Tx) => Promise<void>) {
  return main.commit(async tx => {
    const { requestId, decision, note } = answer;
    const { pending } = await tx.doc(Requests, main.id);
    const req = Object.hasOwn(pending, requestId) ? pending[requestId] : undefined;
    if (!req || req.audience !== "user" || req.checking || !isApprovalDecision(decision)) return reply("No pending user decision", true);
    const now = (approvalClocks.get(main) ?? Date.now)();
    if (now >= req.expiresAt) return reply(expiredMessage, true);
    const task = (await tx.doc(Tasks, main.id)).byId[req.taskId];
    if (!req.deferred) {
      const status = await tx.signal(req.toolTask, Decision, req.wakeKey ?? req.id, { allow: decision !== "deny", ...(note && { note }) });
      // At the soft deadline pi-durable closes the signal, but its gate is waking and reads the durable decision.
      if (status !== "delivered" && !(status === "closed" && !req.wakeKey && req.defaultAt && now >= req.defaultAt)) return reply(status, true);
    }
    const { byId } = await tx.doc(Reviews, main.id);
    byId[requestId] = { ...byId[requestId], taskId: req.taskId, tool: req.tool, user: decision, userAt: now, ...(note && { note }) };
    const caller = await currentCaller(tx, main, req.taskId, task);
    if (decision === "always") {
      const grants = await tx.doc(AllowedCapabilities, main.id);
      if (!grants.capabilities.includes(req.capability)) grants.capabilities.push(req.capability);
    }
    let granted = false;
    if (caller !== undefined) {
      if (decision === "once") {
        await rememberOnce(tx, caller, req.tool, now);
      } else if (decision === "capability") {
        if (task) {
          granted = true;
          const scope = await tx.doc(ScopeDoc, caller);
          scope.capabilities ??= [];
          if (!scope.capabilities.includes(req.capability)) scope.capabilities.push(req.capability);
        } else if (req.leaseId) {
          const leases = await tx.doc(Leases, main.id);
          granted = holdsLease(leases, req.capability, req.leaseId);
          if (granted) {
            leases.grants ??= {};
            leases.grants[req.capability] = req.leaseId;
          }
        }
      } else if (decision === "deny" && task) {
        const audit = await tx.doc(Audit, main.id);
        audit.refused ??= {};
        audit.refused[`${req.taskId} ${req.tool}`] = true;
      }
    }
    for (const other of Object.values(pending)) {
      if (other.id === req.id || now >= other.expiresAt || other.capability !== req.capability) continue;
      if (decision !== "always" && (other.taskId !== req.taskId || caller === undefined)) continue;
      if (decision === "deny" && (!task || other.tool !== req.tool)) continue;
      if (decision === "once" && other.tool !== req.tool) continue;
      if (decision === "capability" && !granted) continue;
      if (!other.deferred) await tx.signal(other.toolTask, Decision, other.wakeKey ?? other.id, { allow: decision !== "deny" });
      delete pending[other.id];
    }
    delete pending[requestId];
    await interacted(tx, now);
    await onDelivered?.(tx);
    return reply("delivered");
  }, context);
}

export async function migrateRequests(tx: Tx, main: Conversation, at: number, timeout: number) {
  const { pending } = await tx.doc(Requests, main.id);
  const tasks = (await tx.doc(Tasks, main.id)).byId;
  const audit = await tx.doc(Audit, main.id);
  for (const entry of audit.entries) {
    if (entry.decision === "park" && !entry.audience && (Reflect.get(entry, "tainted") || tasks[entry.taskId]?.permission === "auto")) {
      entry.audience = "user";
    }
    const effect = normalizeEffect(entry.effect);
    if (entry.effect !== effect) entry.effect = effect;
    Reflect.deleteProperty(entry, "tainted");
  }
  for (const lease of Object.values((await tx.doc(LeaseHistory, main.id)).byId)) Reflect.deleteProperty(lease, "tainted");
  for (const review of Object.values((await tx.doc(Reviews, main.id)).byId)) {
    if (review.timeoutAt !== undefined && review.judgment?.inScope && review.itemCount && !review.ended && !review.user) {
      review.judgeAllowedAt ??= review.timeoutAt;
    }
    if ((review.user as string | undefined) === "statement") review.user = "once";
    if (review.user === "once" && review.userAt !== undefined && review.userAt + onceWindow > at && review.tool && review.taskId) {
      const caller = await currentCaller(tx, main, review.taskId, tasks[review.taskId]);
      if (caller !== undefined) await rememberOnce(tx, caller, review.tool, review.userAt);
    }
    if ((review.user as string | undefined) === "task-full") {
      review.user = "capability";
      const task = review.taskId && tasks[review.taskId];
      if (!task || (await tx.doc(TaskIdentity, task.conversationId)).taskId !== review.taskId) continue;
      const scope = await tx.doc(ScopeDoc, task.conversationId);
      const capability = audit.entries.find(e => e.taskId === review.taskId && e.tool === review.tool)?.capability;
      Reflect.deleteProperty(scope, "full");
      if (capability) {
        scope.capabilities ??= [];
        if (!scope.capabilities.includes(capability)) scope.capabilities.push(capability);
      }
    }
  }
  for (const req of Object.values(pending)) {
    Reflect.deleteProperty(req, "taint");
    Reflect.deleteProperty(req, "tainted");
    if (req.taskId === "main" && req.tool === "enable_tool") {
      await tx.signal(req.toolTask, Decision, req.wakeKey ?? req.id, { allow: true });
      delete pending[req.id];
      continue;
    }
    if (req.taskId === "main" && !req.leaseId) {
      const leases = await tx.doc(Leases, main.id);
      const key = activeLease(leases.lastUsed, req.capability, req.tool.slice(req.capability.length + 1));
      const id = key && leases.records?.[key];
      // A replacement lease has a newer tool task than the old card.
      if (key && (!id || Number(id) < req.toolTask)) req.leaseId = id ?? key;
    }
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
  mainControl: (name: string) => boolean, mode: () => ApprovalMode, judge: (statement: PermissionItem[], call: ApprovalCall, owner: { taskId?: string; wakeId?: string }, context?: ApprovalContext) => Promise<Judgment>) {
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
        const control = call.name === "finish" || call.name === "sleep";
        const descriptor: ToolAction | undefined = control ? { capability: "task", action: call.name, effect: "write" }
          : isMain && call.name === "send_message" ? { capability: "notifications", action: "send_message", effect: "write" }
          : isMain && call.name === "digest_source" ? { capability: "notifications", action: "digest_source", effect: "read" }
          : registry.toolActions.get(call.name);
        const borrowed = call.parent && /^ext:([a-z0-9-]+):([^:]+):\d+$/.exec(call.id.slice(call.parent.callId.length + 1));
        const borrower = borrowed?.[1];
        if (isMain && !descriptor && !borrower && mainControl(call.name)) return;
        const identity = isMain ? undefined : await api.snapshot(TaskIdentity, api.conversationId, ctx);
        const taskId = isMain ? "main" : identity?.taskId ?? "";
        const id = `permission-${api.taskId}`;
        const signal = await api.readSignal(Decision, id, ctx);
        const { capability, action } = descriptor ?? { capability: "unknown", action: call.name };
        const effect = normalizeEffect(descriptor?.effect);
        return main.commit(async tx => {
          const task = (await tx.doc(Tasks, main.id)).byId[taskId];
          const leasedCall = isMain && registry.toolActions.has(call.name) && capability !== "memory" && capability !== "schedule";
          const leases = leasedCall ? await tx.doc(Leases, main.id) : undefined;
          const key = leases && activeLease(leases.lastUsed, capability, action);
          if (leases && !key) return { block: "No active lease" };
          const leaseId = key && leases?.records?.[key];
          const history = leaseId ? await tx.doc(LeaseHistory, main.id) : undefined;
          const lease = leaseId ? history?.byId[leaseId] : undefined;
          const wake = lease ? await activeWake(tx, main.id, api.now()) : undefined;
          const audit = await tx.doc(Audit, main.id);
          const { pending } = await tx.doc(Requests, main.id);
          const at = api.now();
          function record(decision: AuditEntry["decision"]) {
            if (audit.last[id] === decision) return;
            audit.entries.push({ taskId, tool: call.name, capability, action, effect, decision, at, ...(borrower && { borrower }),
              ...(decision === "park" && { audience: "user" as const }) });
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
          if (!isMain && task?.status !== "running") return block("Inactive task");
          if (borrowed && (!descriptor || !permitsBorrow(borrowed[2]!, effect))) return block("Borrow exceeds calling effect");
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
          // The main session's own notes, schedules and notifications are bookkeeping, not actions on the outside world.
          const internal = control || (isMain && !leasedCall && (call.name === "send_message" || capability === "memory" || capability === "schedule"));
          const needsApproval = effect !== "read" && !internal &&
            !(effect === "irreversible" && task?.permission === "full");
          if (req && at >= req.expiresAt) { await expire(tx, main, req, at); return block(expiredMessage); }
          const scope = await tx.doc(ScopeDoc, api.conversationId);
          const always = await tx.doc(AllowedCapabilities, main.id);
          const granted = always.capabilities.includes(capability) || (leases
            ? holdsLease(leases, capability, leases.grants?.[capability])
            : scope.capabilities?.includes(capability));
          if (!granted && !isMain && audit.refused?.[`${taskId} ${call.name}`]) {
            delete pending[id];
            return block(`The user already declined ${call.name} in this task. Do not retry it; finish and report that the user declined.`);
          }
          if (!needsApproval || granted || audit.last[id] === "allow" ||
              scope.late.some(item => item.tool === call.name && item.expiresAt > at)) {
            delete pending[id];
            record("allow");
            return;
          }
          const setting = mode();
          if (!req) {
            const argumentsJson = JSON.stringify(call.arguments, (_, value) =>
              value && typeof value === "object" && !Array.isArray(value)
                ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
            if (Object.values(pending).some(r => r.taskId === taskId && r.deferred && r.tool === call.name &&
              r.argumentsJson === argumentsJson && r.expiresAt > at)) return block(deferredMessage);
            const items = isMain ? (await recentUserText(tx, main.id, at) ?? []).map(purpose => ({ tool: "", target: "", purpose })) : scope.items;
            const checking = effect === "write" && setting === "on" && items.length > 0;
            const reason = task?.brief ?? "Main session tool call";
            pending[id] = { id, toolTask: api.taskId, taskId, audience: "user", capability, tool: call.name,
              argumentsJson, ...(key && { leaseId: leaseId ?? key }), reason: (borrower ? "插件 " + borrower + " 借用：" : "") + reason, expiresAt: at + timeout,
              statement: items.map((item, index) => ({ ...item, isNew: scope.shown !== undefined && index >= scope.shown })),
              defaultAt: at + Math.min(defaultMs, timeout), ...(checking && { checking: true }) };
            req = pending[id]!;
            if (checking) {
              byId[id] = { taskId, tool: call.name, itemCount: items.length };
              await tx.createTask(review, { id, taskId, conversationId: api.conversationId, ...(task?.wakeId && { wakeId: task.wakeId }), toolTask: api.taskId, statement: items,
                tool: call.name, argumentsJson }, { ownership: { kind: "conversation" }, background: true });
            }
          }
          if (setting === "on" && req.checking && effect === "write") {
            if (byId[id]?.itemCount !== undefined && !result?.judgment) {
              req.wakeKey = id + "-review";
              return { sleep: { until: req.expiresAt, signals: [Reviewed.key(id), Decision.key(req.wakeKey)] } };
            }
            if (result?.judgment?.inScope && result.itemCount) {
              result.judgeAllowedAt = at;
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
          }
          if (audit.last[id] !== "park") {
            scope.shown = req.statement?.length ?? 0;
            record("park");
          }
          const defaultReached = req.defaultAt !== undefined && at >= req.defaultAt;
          if (defaultReached) {
            if (!req.deferred) {
              req.deferred = true;
              byId[id] = { ...byId[id], taskId, tool: call.name, ended: "deferred", timeoutAt: at };
              await tx.createTask(expiry, { id }, { ownership: { kind: "conversation" }, background: true });
            }
            return block(deferredMessage);
          }
          delete req.wakeKey;
          return { sleep: { until: req.defaultAt ?? req.expiresAt, signals: [Decision.key(id)] } };
        }, ctx);
      },
      async afterTool(call, result, api, ctx) {
        const action = registry.toolActions.get(call.name);
        const main = getMain();
        if (api.conversationId !== main.id || (!action && !result.isError)) return;
        await main.commit(async tx => {
          const id = `permission-${api.taskId}`;
          const history = await tx.doc(LeaseHistory, main.id);
          const leaseId = history.inFlight[id];
          if (leaseId) {
            history.byId[leaseId]![result.isError ? "failed" : "succeeded"]++;
            delete history.inFlight[id];
          }
          if (result.isError) {
            const { pending } = await tx.doc(Requests, main.id);
            if (!pending[id]?.deferred) delete pending[id];
          }
        }, ctx);
      },
    })],
  });
}
