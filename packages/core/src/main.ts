import { obj, opt, str } from "@earendil-works/pi-schema";
import { createBroker, mainApprovalTool, Requests } from "./broker.ts";
import { createDemoCapabilities, manifests, toolActions } from "./capabilities.ts";
import {
  configure, context, conversationDoc, createRegistry, defineExtension, defineTask, defineTool,
  GenerationTask, Harness, hook, hookTask, reply, ToolTask, type Conversation,
  type ConversationId, type HarnessOptions, type ModelRef, type Storage, type ToolRegistration, type Tx,
} from "./runtime.ts";
import { Tasks } from "./state.ts";
import { BackgroundTask, dispatchTool, TaskTools } from "./tasks.ts";

export const Leases = conversationDoc<{ turns: number; lastUsed: Record<string, number> }>(
  "leases", () => ({ turns: 0, lastUsed: {} }),
);
const leaseWindow = 30;

export async function openAlter(storage: Storage, models: HarnessOptions["models"], model: ModelRef) {
  const demo = createDemoCapabilities();
  const broker = createBroker(() => main);
  const taskExtensions = [demo.extension, TaskTools, broker];

  async function updateOffered(tx: Tx, id: ConversationId, lastUsed: Record<string, number>) {
    const leased = demo.tools.filter(tool => Object.hasOwn(lastUsed, toolActions.get(tool.name)!.capability));
    await configure(tx, id, { modelTools: [...controls, ...leased] });
  }

  const controls: ToolRegistration[] = [
    dispatchTool(taskExtensions),
    defineTool({
      name: "task_status", description: "Show task status and any pending permission requests.",
      parameters: obj({ taskId: opt(str()) }), replay: "safe",
      async execute({ taskId }, api, ctx) {
        const tasks = (await api.snapshot(Tasks, api.conversationId, ctx))?.byId ?? {};
        const requests = (await api.snapshot(Requests, api.conversationId, ctx))?.pending ?? {};
        const status = Object.entries(tasks).filter(([id]) => !taskId || id === taskId).map(([id, task]) => ({
          taskId: id, ...task, pending: Object.values(requests).filter(request => request.taskId === id),
        }));
        return reply(JSON.stringify(status));
      },
    }),
    mainApprovalTool(() => main),
    defineTool({
      name: "enable_tool", description: "Lease a main-leasable capability for direct use.",
      parameters: obj({ capability: str(), reason: str({ minLength: 1 }) }), replay: "safe",
      async execute({ capability }, api, ctx) {
        if (!manifests.find(item => item.id === capability)?.mainLeasable) return reply("Capability is not leasable", true);
        await api.commit(async tx => {
          const leases = await tx.doc(Leases, api.conversationId);
          leases.lastUsed[capability] = leases.turns + 1;
          await updateOffered(tx, api.conversationId, leases.lastUsed);
        }, ctx);
        return reply(`Enabled ${capability}`);
      },
    }),
  ];

  // afterRun children finish before queued follow-ups are placed, including on recovery.
  const AdvanceLeases = defineTask<null, { phase: "advance" }, null>({
    name: "alter.advance-leases", version: 1, initial: () => ({ phase: "advance" }),
    phases: {
      advance: (_, runtime, ctx) => runtime.commit(async tx => {
        const leases = await tx.doc(Leases, runtime.conversationId);
        leases.turns++;
        for (const [id, last] of Object.entries(leases.lastUsed)) {
          if (leases.turns - last >= leaseWindow) delete leases.lastUsed[id];
        }
        await updateOffered(tx, runtime.conversationId, leases.lastUsed);
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, ctx),
    },
    abort: (_, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });

  const controlPlane = defineExtension({
    name: "alter.main", tools: controls, tasks: [AdvanceLeases, BackgroundTask],
    hooks: [
      hook(GenerationTask, { afterRun: () => ({ tasks: [hookTask(AdvanceLeases, null)] }) }),
      hook(ToolTask, { async beforeTool(call, _, ctx) {
        const action = toolActions.get(call.name);
        if (!action) return;
        return main.commit(async tx => {
          const leases = await tx.doc(Leases, main.id);
          if (!Object.hasOwn(leases.lastUsed, action.capability)) return { block: "No active lease" };
          leases.lastUsed[action.capability] = leases.turns + 1;
        }, ctx);
      } }),
    ],
  });
  const registry = createRegistry();
  for (const extension of [...taskExtensions, controlPlane]) registry.install(extension);
  const harness = await Harness.open(storage, { models, registry, settings: { toolExecution: "sequential" } }, context);
  const main: Conversation = await harness.root(context, { agent: {
    model, extensions: [controlPlane, demo.extension], modelTools: controls,
    instructions: "Lease calendar for short, frequent edits. Dispatch long, exploratory or multi-step work.",
  } });
  return { harness, main, demo };
}
