import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { type CapabilityRegistry, type Effect } from "./capabilities.ts";
import {
  context, conversationDoc, defineExtension, defineSignal, defineTool, hook, reply, ToolTask,
  type Conversation, type TaskId, type Tx,
} from "./runtime.ts";
import { TaskIdentity, Tasks } from "./state.ts";

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
};
type AuditEntry = {
  taskId: string;
  tool: string;
  capability: string;
  action: string;
  effect: Effect;
  decision: "park" | "allow" | "deny";
  at: number;
};
export type PermissionState = { pending: Record<string, Request> };
export const Requests = conversationDoc<PermissionState>("permissions", () => ({ pending: {} }));
export const Audit = conversationDoc<{ entries: AuditEntry[]; last: Record<string, AuditEntry["decision"]> }>(
  "audit", () => ({ entries: [], last: {} }),
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

export function createBroker(getMain: () => Conversation, registry: CapabilityRegistry, timeout: number) {
  return defineExtension({
    name: "alter.broker",
    hooks: [hook(ToolTask, {
      async beforeTool(call, api, ctx) {
        const main = getMain();
        const identity = await api.snapshot(TaskIdentity, api.conversationId, ctx);
        if (!identity?.taskId) return { block: "Missing task identity" };
        const taskId = identity.taskId;
        const requestId = `permission-${api.taskId}`;
        const signal = await api.readSignal(Decision, requestId, ctx);
        const descriptor = describeCall(registry, call.name, call.arguments);
        const { capability, action, effect } = descriptor ?? {
          capability: String(call.arguments.capability ?? "unknown"), action: call.name, effect: "unknown" as const,
        };
        return main.commit(async tx => {
          const task = (await tx.doc(Tasks, main.id)).byId[taskId];
          const audit = await tx.doc(Audit, main.id);
          const requests = await tx.doc(Requests, main.id);
          function record(decision: AuditEntry["decision"]) {
            if (audit.last[requestId] === decision) return;
            audit.entries.push({ taskId, tool: call.name, capability, action, effect, decision, at: api.now() });
            audit.last[requestId] = decision;
          }
          if (!task || task.status !== "running" || !descriptor) {
            record("deny");
            return { block: "Unknown capability or inactive task" };
          }
          if (signal) {
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
              return { block: signal.value.note ?? "Permission denied" };
            }
            record("allow");
            return;
          }
          // Main reads task reports and external data, so it can be injected: only the user approves
          // calls that leave the machine or cannot be undone. An approved request_capability only adds
          // to the allow list, which never covers those calls (ADR-0004, #13).
          const userOnly = call.name !== "request_capability" && (effect === "external-send" || effect === "irreversible" || effect === "unknown");
          const permitted = call.name === "finish" || task.permission === "full"
            || (task.permission === "restricted" && task.allow.includes(capability) && !userOnly)
            || (task.permission === "auto" && (effect === "read" || effect === "write-local"));
          if (permitted && !requests.pending[requestId]) {
            record("allow");
            return;
          }
          if (!requests.pending[requestId]) {
            const audience = task.permission === "auto" || userOnly ? "user" : "main";
            const reason = call.name === "request_capability" ? String(call.arguments.reason) : task.brief;
            requests.pending[requestId] = {
              id: requestId, toolTask: api.taskId, taskId, audience, reason, capability,
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
    })],
  });
}
