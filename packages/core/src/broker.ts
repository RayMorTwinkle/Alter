import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { type CapabilityRegistry, type Effect } from "./capabilities.ts";
import {
  context, conversationDoc, defineExtension, defineSignal, defineTool, hook, reply, ToolTask,
  type Conversation, type TaskId, type Tx,
} from "./runtime.ts";
import { isUntrusted, Taint, type TaintSource } from "./taint.ts";
import { TaskIdentity, Tasks, type Permission } from "./state.ts";

type Audience = "main" | "user";
type Request = {
  id: string;
  taskId: string;
  toolTask: TaskId;
  audience: Audience;
  capability: string;
  tool: string;
  reason: string;
  argumentsJson: string;
  expiresAt: number;
  tainted?: true;
  taint?: TaintSource;
};
type AuditEntry = {
  taskId: string;
  tool: string;
  capability: string;
  action: string;
  effect: Effect;
  decision: "park" | "allow" | "deny";
  at: number;
  tainted?: true;
};
export type PermissionState = { pending: Record<string, Request> };
export const Requests = conversationDoc<PermissionState>("permissions", () => ({ pending: {} }));
// refused: "<taskId> <tool>" pairs the user explicitly denied. Absent in stores written before #30.
export const Audit = conversationDoc<{ entries: AuditEntry[]; last: Record<string, AuditEntry["decision"]>; refused?: Record<string, true> }>(
  "audit", () => ({ entries: [], last: {}, refused: {} }),
);
const Decision = defineSignal({
  name: "alter.permission", version: 1, schema: obj({ allow: bool(), note: opt(str()) }),
});
type Answer = { requestId: string; allow: boolean; note?: string };

async function deliver(tx: Tx, main: Conversation, audience: Audience, answer: Answer) {
  const { pending } = await tx.doc(Requests, main.id);
  const request = Object.hasOwn(pending, answer.requestId) ? pending[answer.requestId] : undefined;
  if (!request || request.audience !== audience) return reply("No pending request for this approver", true);
  if (Date.now() >= request.expiresAt) return reply("Approval expired without a decision", true);
  const value = answer.note === undefined ? { allow: answer.allow } : { allow: answer.allow, note: answer.note };
  const result = await tx.signal(request.toolTask, Decision, request.id, value);
  return reply(result, result !== "delivered" && result !== "duplicate");
}

export function answerUserPermission(main: Conversation, answer: Answer) {
  return main.commit(tx => deliver(tx, main, "user", answer), context);
}

export function mainApprovalTool(main: () => Conversation) {
  return defineTool({
    name: "answer_permission_request", description: "Allow or deny a restricted task's capability request. Sends and irreversible actions go to the user.",
    parameters: obj({ requestId: str(), allow: bool(), note: opt(str()) }),
    execute: (answer, api, ctx) => api.commit(tx => deliver(tx, main(), "main", answer), ctx),
  });
}

const riskOrder: Effect[] = ["read", "write-local", "external-send", "irreversible", "unknown"];
function describeCall({ manifests, toolActions }: CapabilityRegistry, name: string, args: Record<string, unknown>) {
  if (name === "finish") return { capability: "task", action: "finish", effect: "write-local" as const };
  if (name !== "request_capability") return toolActions.get(name);
  const manifest = manifests.find(item => item.id === args.capability);
  if (!manifest || typeof args.reason !== "string" || !args.reason.trim()) return undefined;
  const effect = riskOrder.findLast(risk => manifest.actions.some(action => action.effect === risk)) ?? "unknown";
  return { capability: manifest.id, action: "request", effect };
}

function approver(permission: Permission, tool: string, listed: boolean, risky: boolean, tainted: boolean): Audience | undefined {
  if (tool === "finish") return;
  if (tool !== "request_capability" && risky && tainted) return "user";
  if (permission === "full") return;
  if (risky && (tool !== "request_capability" || permission === "auto")) return "user";
  if (permission === "restricted" && !listed) return "main";
  return undefined;
}

export function createBroker(getMain: () => Conversation, registry: CapabilityRegistry, timeout: number) {
  return defineExtension({
    name: "alter.broker",
    hooks: [hook(ToolTask, {
      async beforeTool(call, api, ctx) {
        const main = getMain();
        const isMain = api.conversationId === main.id;
        if (isMain && !registry.toolActions.has(call.name)) return; // Main control-plane tools.
        const taskId = isMain ? "main" : (await api.snapshot(TaskIdentity, api.conversationId, ctx))?.taskId ?? "";
        if (!taskId) return { block: "Missing task identity" };
        const requestId = `permission-${api.taskId}`;
        const signal = await api.readSignal(Decision, requestId, ctx);
        const descriptor = describeCall(registry, call.name, call.arguments);
        const { capability, action, effect } = descriptor ?? {
          capability: String(call.arguments.capability ?? "unknown"), action: call.name, effect: "unknown" as const,
        };
        return main.commit(async tx => {
          const task = (await tx.doc(Tasks, main.id)).byId[taskId];
          const risky = effect === "external-send" || effect === "irreversible" || effect === "unknown";
          const taint = risky && call.name !== "request_capability" ? (await tx.doc(Taint, api.conversationId)).first : undefined;
          const audit = await tx.doc(Audit, main.id);
          const requests = await tx.doc(Requests, main.id);
          function record(decision: AuditEntry["decision"]) {
            if (audit.last[requestId] === decision) return;
            audit.entries.push({ taskId, tool: call.name, capability, action, effect, decision, at: api.now(),
              ...(taint && { tainted: true as const }) });
            audit.last[requestId] = decision;
          }
          if ((!isMain && task?.status !== "running") || !descriptor) {
            record("deny");
            return { block: "Unknown capability or inactive task" };
          }
          const refusal = `${taskId} ${call.name}`;
          if (signal) {
            const askedUser = requests.pending[requestId]?.audience === "user";
            delete requests.pending[requestId];
            if ("expired" in signal) {
              const reason = "Approval expired without a decision";
              await main.submit(tx, {
                type: "input", whenBusy: "followUp", requestId: `expired-${requestId}`,
                content: `Notify the user: task ${taskId}, request ${requestId} (${call.name}): ${reason}`,
              });
              record("deny");
              return { block: reason };
            }
            if (!signal.value.allow) {
              record("deny");
              if (askedUser) (audit.refused ??= {})[refusal] = true;
              // Without this, models tend to re-request the capability and retry, asking the user again.
              // Naming the decider matters: "permission denied" reads as a system fault, and main re-dispatches.
              const note = signal.value.note ? ` Note: ${signal.value.note}` : "";
              const who = askedUser ? "The user declined" : "The main session declined";
              return { block: `${who} this ${call.name} call.${note} This is a decision, not a system error. Do not retry it or request the capability again; finish and report that it was declined.` };
            }
            record("allow");
            return;
          }
          // A capability grant does not authorize later calls. Preserve its existing tier policy.
          const audience = approver(task?.permission ?? "full", call.name, task?.allow.includes(capability) ?? false, risky, !!taint);
          // Prompts alone do not stop retries after a denial, so the user is never asked twice in one task.
          if (audience === "user" && !isMain && audit.refused?.[refusal] && !requests.pending[requestId]) {
            record("deny");
            return { block: `The user already declined ${call.name} in this task. Do not call it again; finish and report that the user declined.` };
          }
          if (!audience && !requests.pending[requestId]) {
            record("allow");
            return;
          }
          if (audience && !requests.pending[requestId]) {
            const reason = call.name === "request_capability" ? String(call.arguments.reason) : task?.brief ?? "Main session tool lease";
            requests.pending[requestId] = {
              id: requestId, toolTask: api.taskId, taskId, audience, reason, capability,
              ...(taint && { tainted: true as const, taint: { ...taint } }),
              expiresAt: api.now() + timeout, tool: call.name, argumentsJson: JSON.stringify(call.arguments),
            };
            if (audience === "main") {
              await main.submit(tx, {
                type: "input", whenBusy: "followUp", requestId,
                content: `permission request ${requestId}: task ${taskId} wants ${capability} because ${reason}`,
              });
            }
            record("park");
          }
          return { sleep: { until: requests.pending[requestId]!.expiresAt, signals: [Decision.key(requestId)] } };
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
            if (untrusted) (await tx.doc(Taint, api.conversationId)).first ??= {
              source: call.name, capability: action.capability, at: api.now(),
            };
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
