import { obj, opt, str } from "@earendil-works/pi-schema";
import { createBroker, mainApprovalTool, Requests } from "./broker.ts";
import { createCapabilityRegistry, createDemoCapabilities, type AlterPlugin, type ExternalEvent, type PluginHost } from "./capabilities.ts";
import {
  configure, context, conversationDoc, createRegistry, defineExtension, defineTask, defineTool,
  GenerationTask, Harness, hook, hookTask, reply, ToolTask, type Conversation,
  type ConversationId, type HarnessOptions, type ModelRef, type ModelThinkingLevel, type Storage, type ToolRegistration, type Tx,
} from "./runtime.ts";
import { defaultApprovalTimeoutMs, validateApprovalTimeout } from "./config.ts";
import { inputClock } from "./clock.ts";
import { mainClocks } from "./timeline.ts";
import { Tasks } from "./state.ts";
import { BackgroundTask, dispatchTool, TaskTools } from "./tasks.ts";

export const Events = conversationDoc<{ entries: ExternalEvent[] }>("events", () => ({ entries: [] }));
export const Leases = conversationDoc<{ turns: number; lastUsed: Record<string, number> }>(
  "leases", () => ({ turns: 0, lastUsed: {} }),
);
export const leaseWindow = 30;

export async function openAlter(
  storage: Storage, models: HarnessOptions["models"], mainModel: ModelRef, taskModel: ModelRef = mainModel,
  thinking: { main?: ModelThinkingLevel; task?: ModelThinkingLevel } = {},
  options: { leasing?: boolean; demos?: boolean; plugins?: AlterPlugin[]; approvalTimeoutMs?: number; timeZone?: string; now?: () => number } = {},
) {
  const leasing = options.leasing ?? true;
  const clock = inputClock(options.timeZone, options.now);
  const plugins = options.plugins ?? [];
  const capabilities = createCapabilityRegistry(plugins, options.demos ?? true);
  const demo = createDemoCapabilities(capabilities.activeDemos);
  const descriptions: Record<string, string> = {
    calendar: "calendar（示例日历，仅标题）", notes: "notes（示例笔记 welcome）", outbox: "outbox（模拟发送）",
  };
  const available = [...capabilities.activeDemos.map(cap => descriptions[cap.id] ?? cap.id), ...plugins.map(({ capability }) =>
    capability.id === "calendar" ? "calendar（日历，可管理标题、时间、地点、备注）" : capability.id)];
  const leasable = new Set(capabilities.manifests.filter(cap => leasing && cap.mainLeasable).map(cap => cap.id));
  const mainInstructions = "你是 Alter 的主助手，负责与用户对话，默认跟随用户的语言。" +
    (leasable.has("calendar") ? "简短、频繁的日程操作可用 enable_tool 租用 calendar。" : "") +
    `多步或探索性工作用 dispatch_task 派单，可用能力有 ${available.join("、")}。` +
    "用 task_status 查进度，收到任务报告后回复用户。你可以答复受限任务的能力申请；对外发送、不可逆操作总是由用户亲自批准，allow 清单不能代替；系统会自动向用户弹出审批，派单时不必在 brief 里提审批。用户拒绝的操作不要换任务或换方式重试，如实告诉用户已被拒绝，等用户的新指示。";
  const { toolActions } = capabilities;
  const tools = [...demo.tools, ...plugins.flatMap(plugin => plugin.tools)];
  const extension = defineExtension({ name: demo.extension.name, tools });
  const timeout = validateApprovalTimeout(options.approvalTimeoutMs ?? defaultApprovalTimeoutMs);
  const broker = createBroker(() => main, capabilities, timeout);
  const taskExtensions = [extension, TaskTools, broker];

  async function updateOffered(tx: Tx, id: ConversationId, lastUsed: Record<string, number>) {
    const leased = tools.filter(tool => {
      const id = toolActions.get(tool.name)!.capability;
      return leasable.has(id) && Object.hasOwn(lastUsed, id);
    });
    await configure(tx, id, { modelTools: [...controls, ...leased] });
  }

  const controls: ToolRegistration[] = [
    dispatchTool(capabilities, taskExtensions, taskModel, clock, thinking.task),
    defineTool({
      name: "task_status", description: "Show task status and any pending permission requests.",
      parameters: obj({ taskId: opt(str()) }), replay: "safe",
      async execute({ taskId }, api, ctx) {
        const tasks = (await api.snapshot(Tasks, api.conversationId, ctx))?.byId ?? {};
        const requests = (await api.snapshot(Requests, api.conversationId, ctx))?.pending ?? {};
        const status = Object.entries(tasks).filter(([id]) => !taskId || id === taskId).map(([id, task]) => ({
          taskId: id, ...task, pending: Object.values(requests).filter(request => request.taskId === id)
            .map(request => ({ ...request, remainingMs: Math.max(0, request.expiresAt - api.now()) })),
        }));
        return reply(JSON.stringify(status));
      },
    }),
    mainApprovalTool(() => main),
  ];
  if (leasing) controls.push(
    defineTool({
      name: "enable_tool", description: "Lease a main-leasable capability for direct use.",
      parameters: obj({ capability: str(), reason: str({ minLength: 1 }) }), replay: "safe",
      async execute({ capability }, api, ctx) {
        if (!leasable.has(capability)) return reply("Capability is not leasable", true);
        await api.commit(async tx => {
          const leases = await tx.doc(Leases, api.conversationId);
          leases.lastUsed[capability] = leases.turns + 1;
          await updateOffered(tx, api.conversationId, leases.lastUsed);
        }, ctx);
        return reply(`Enabled ${capability}`);
      },
    }),
  );

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
      ...plugins.flatMap(({ onTaskEnd }) => onTaskEnd ? [hook(BackgroundTask, {
        async onTaskEnd(taskId) {
          const task = (await harness.snapshot(Tasks, main.id, context))?.byId[taskId];
          const child = task && await harness.conversation(task.conversationId, context);
          if (child) await onTaskEnd(child);
        },
      })] : []),
      hook(GenerationTask, { afterRun: () => ({ tasks: [hookTask(AdvanceLeases, null)] }) }),
      hook(ToolTask, { async beforeTool(call, _, ctx) {
        const action = toolActions.get(call.name);
        if (!action) return;
        return main.commit(async tx => {
          const leases = await tx.doc(Leases, main.id);
          if (!leasable.has(action.capability) || !Object.hasOwn(leases.lastUsed, action.capability)) return { block: "No active lease" };
          leases.lastUsed[action.capability] = leases.turns + 1;
        }, ctx);
      } }),
    ],
  });
  const registry = createRegistry();
  for (const extension of [...taskExtensions, controlPlane]) registry.install(extension);
  const harness = await Harness.open(storage, {
    models, registry, settings: { toolExecution: "sequential", retry: { enabled: false } },
  }, context);
  const main: Conversation = await harness.root(context, { agent: {
    extensions: [controlPlane, extension, broker], modelTools: controls,
  } });
  // root's agent options only apply on creation. Upgrade M0's model refs before resume,
  // preserving persisted leases, granted capabilities and the conversational history.
  await main.commit(async tx => {
    await configure(tx, main.id, { extensions: [controlPlane, extension, broker], model: mainModel, thinkingLevel: thinking.main, instructions: mainInstructions });
    const leases = await tx.doc(Leases, main.id);
    for (const id of Object.keys(leases.lastUsed)) if (!leasable.has(id)) delete leases.lastUsed[id];
    await updateOffered(tx, main.id, leases.lastUsed);
    // Pre-timeout requests get one approval window at upgrade. On resume the runtime rechecks parked gates.
    const requests = await tx.doc(Requests, main.id);
    for (const request of Object.values(requests.pending)) request.expiresAt ??= Date.now() + timeout;
    const tasks = await tx.doc(Tasks, main.id);
    for (const [id, task] of Object.entries(tasks.byId)) {
      if (task.context === undefined || task.createdAt === undefined) {
        const child = await tx.conversation(task.conversationId);
        task.context ??= child?.parent ? "fork" : "fresh";
        const brief = (await tx.submissionByRequest(task.conversationId, `brief-${id}`))?.entry;
        task.createdAt ??= brief === undefined ? 0 : (await tx.entry(brief))?.model?.[0]?.timestamp ?? 0;
      }
      if (task.status === "running") await configure(tx, task.conversationId, { model: taskModel, thinkingLevel: thinking.task });
    }
  }, context);
  const host: PluginHost = {
    emit: event => main.commit(async tx => {
      const { entries } = await tx.doc(Events, main.id);
      entries.push({ ...event, untrusted: true });
      if (entries.length > 500) entries.splice(0, entries.length - 500);
    }, context),
  };
  const stops: (() => Promise<void>)[] = [];
  let closing: Promise<void> | undefined;
  async function shutdown() {
    const results = await Promise.allSettled(stops.reverse().map(async stop => stop()));
    await harness.close(context);
    const errors = results.filter(r => r.status === "rejected").map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, "Plugin shutdown failed");
  }
  try {
    for (const plugin of plugins) if (plugin.start) stops.push(await plugin.start(host));
  } catch (error) {
    await shutdown();
    throw error;
  }
  mainClocks.set(main, clock);
  return { harness, main, demo, capabilities, close: () => closing ??= shutdown() };
}
