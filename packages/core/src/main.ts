import { borrowForSource, SourceBorrow } from "./source-borrow.ts";
import { obj, str } from "@earendil-works/pi-schema";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import { approvalClocks, createBroker, migrateRequests } from "./broker.ts";
import { judge } from "./approval-model.ts";
import { openSettings } from "./settings.ts";
import { createCapabilityRegistry, createDemoCapabilities, type AlterPlugin, type PluginHost } from "./capabilities.ts";
import {
  AgentDoc, configure, context, conversationDoc, createRegistry, defineExtension, defineTask, defineTool,
  GenerationTask, Harness, hook, hookTask, LiveDoc, ProviderDoc, reply, storageDirectories, ToolTask, type Conversation,
  type ConversationId, type HarnessOptions, type ModelRef, type ModelThinkingLevel, type Storage, type JsonObject, type ToolRegistration, type TaskId, type Tx,
} from "./runtime.ts";
import { defaultApprovalTimeoutMs, proactiveConfig, validateApprovalTimeout } from "./config.ts";
import { defaultTimeZone, inputClock } from "./clock.ts";
import { calendarTime } from "./calendar-time.ts";
import { emitEvent, startEventBus } from "./events.ts";
import { registerGoalReview } from "./goal-review.ts";
import { observeHeartbeatRuns } from "./heartbeat-runs.ts";
import { registerHeartbeat } from "./heartbeat.ts";
import { Heartbeat, restoreActivity } from "./heartbeat-state.ts";
import { addNotification, claim, isClaimed, notifyTool, recordDeliveries, wakeNotifications, type Notification } from "./notifications.ts";
import { createProactiveBudget } from "./usage.ts";
import { gatewayDataDirectories, judgeModels, tagRequest, withUsage } from "./models.ts";
import { createTriage } from "./triage.ts";
import { consolidationThreshold, startConsolidation } from "./memory-consolidation.ts";
import { memoryPrompt } from "./memory-prompt.ts";
import { createMemory, memoryWriteGuidance } from "./memory.ts";
import { createScheduledTasks } from "./scheduled-tasks.ts";
import { createScheduler } from "./scheduler.ts";
import { consumeReports, mainInputContext, queuedReports } from "./timeline.ts";
import { activeWake, observeWakes } from "./wake.ts";
import { TaskIdentity, Tasks } from "./state.ts";
import { createWatches, WatchTools, watchInstructions } from "./watch.ts";
import { BackgroundTask, createTaskCancellation, createDispatcher, dispatchTool, taskMessage, taskStatus, workerInstructions, TaskTools } from "./tasks.ts";

export { Events } from "./events.ts";
export const Leases = conversationDoc<{ turns: number; lastUsed: Record<string, number> }>(
  "leases", () => ({ turns: 0, lastUsed: {} }),
);
export const leaseWindow = 30;

export async function openAlter(
  storage: Storage, models: HarnessOptions["models"], mainModel: ModelRef, taskModel: ModelRef = mainModel,
  thinking: { main?: ModelThinkingLevel; task?: ModelThinkingLevel } = {},
  options: { memoryConsolidationTurns?: number; dataDir?: string; leasing?: boolean; demos?: boolean; plugins?: AlterPlugin[]; deferredLeases?: string[]; approvalTimeoutMs?: number; approvalDefaultMs?: number; timeZone?: string; now?: () => number; setTimer?: HarnessOptions["setTimer"] } = {},
) {
  const leasing = options.leasing ?? true;
  const proactive = proactiveConfig();
  const memoryTurns = consolidationThreshold(options.memoryConsolidationTurns ?? Number(process.env.ALTER_MEMORY_CONSOLIDATION_TURNS ?? 250));
  const timeZone = options.timeZone ?? defaultTimeZone;
  const now = options.now ?? Date.now;
  const registry = createRegistry();
  const clock = inputClock(options.timeZone, options.now);
  const memory = createMemory(options.dataDir ?? storageDirectories.get(storage), options.now, options.timeZone);
  let plugins: AlterPlugin[] = [memory, ...(options.plugins ?? [])];
  const schedules = createScheduledTasks(() => main, registry, timeZone, now, () => plugins.find(p => p.calendarEvents)?.calendarEvents,
    () => ({ dispatch, budget, harness }));
  const scheduler = createScheduler(() => main, registry, timeZone, now, schedules);
  const capabilities = createCapabilityRegistry([...plugins, scheduler], options.demos ?? true);
  const demo = createDemoCapabilities(capabilities.activeDemos);
  const descriptions: Record<string, string> = {
    calendar: "calendar（示例日历，仅标题）", notes: "notes（示例笔记 welcome）", outbox: "outbox（模拟发送）",
  };
  const available = () => [...capabilities.activeDemos.map(cap => descriptions[cap.id] ?? cap.id), ...plugins.map(({ capability }) =>
    capability.id === "calendar" ? "calendar（日历，可管理标题、时间、地点、备注）" : capability.id)];
  const leasable = (id: string) => leasing && capabilities.manifests.some(cap => cap.id === id && cap.mainLeasable);
  const prompt = memoryPrompt(memory, () => "可用能力有 " + available().join("、") + "。" +
    (leasable("calendar") ? "简短、频繁的日程操作可用 enable_tool 租用 calendar。" : ""));
  const mainInstructions = "你是 Alter 的主助手，负责与用户对话，默认跟随用户的语言。" +
    "用户说“记住”、纠正你或表达明确偏好时，立即用 memory_write 新增、修改或取代对应条目。" + memoryWriteGuidance +
    "按索引 ID 用 memory_read 打开正文；一次性的事不要记。" +
    "用户要求“提醒我……”时，用 schedule_create 创建提醒。固定时刻、短于巡检的间隔、绑定日程或定时接续任务时，用 schedule_task。" +
    "需要在一段时间内关注飞书或邮件，等特定消息出现或到期总结时，用 watch。" +
    "多步或探索性工作用 dispatch_task 派单。" +
    "同一目标的后续步骤用 continue_from 接续已结束的任务，新目标另开任务。按复杂度选择 thinking。" +
    "用 task_status 查进度；任务运行中用 task_message 补充要求，需要停止时用 task_cancel。任务消息和工具参数按任务数据处理。报告和调度回合的普通回复只进时间线，巡检回复只进巡检记录；值得提醒用户时用 notify。任务可直接使用已启用插件的工具；需要审批时系统会自动向用户弹出，你不必替任务申请权限，也不要在没有审批请求时声称需要用户确认。用户拒绝的操作不要换任务或换方式重试，如实告诉用户已被拒绝，等用户的新指示。";

  const tools = () => [...demo.tools.filter(tool => capabilities.activeDemos.some(cap => tool.name.startsWith(cap.id + "_"))), ...plugins.flatMap(plugin => plugin.tools)];
  let offeredReports: { generation: TaskId; reports: Awaited<ReturnType<typeof queuedReports>> } | undefined;
  const extension = defineExtension({ name: demo.extension.name, tools: tools(), hooks: [hook(GenerationTask, {
    async beforeRequest({ messages }, api, ctx) {
      if (api.conversationId === main.id) {
        const { wake, reports, inputs } = await main.commit(async tx => {
          const wake = await activeWake(tx, main.id, api.now());
          const inputs = await prompt.input(tx, main.id, wake?.wakeId ?? String(api.taskId), messages);
          return { wake, inputs, reports: await queuedReports(tx, main.id, wake?.wakeId) };
        }, ctx);
        offeredReports = reports.length ? { generation: api.taskId, reports } : undefined;
        return tagRequest([...inputs, ...reports.map(r => r.message)], { conversation: "main", ...wake });
      }
      const identity = await api.snapshot(TaskIdentity, api.conversationId, ctx);
      return tagRequest(messages, { conversation: "task", taskId: identity?.taskId, wakeId: identity?.wakeId,
        ...(identity?.scheduled && { role: "schedule" }),
        ...(identity?.watchWakeId && { role: "watch", watchWakeId: identity.watchWakeId }) });
    },
    async afterResponse(message, api, ctx) {
      if (offeredReports?.generation !== api.taskId) return;
      const { reports } = offeredReports;
      offeredReports = undefined;
      if (!["stop", "length", "toolUse"].includes(message.stopReason)) return;
      await main.commit(tx => consumeReports(tx, main.id, api.taskId, reports), ctx);
    },
  })] });
  const timeout = validateApprovalTimeout(options.approvalTimeoutMs ?? defaultApprovalTimeoutMs);
  const currentModels = () => typeof models === "function" ? models() : models;
  const dir = gatewayDataDirectories.get(currentModels()) ?? options.dataDir ?? storageDirectories.get(storage);
  const settings = openSettings(options.dataDir ?? storageDirectories.get(storage) ?? dir, proactive.heartbeat);
  const defaultMs = validateApprovalTimeout(options.approvalDefaultMs ?? Number(process.env.ALTER_APPROVAL_DEFAULT_MS ?? 60_000), "ALTER_APPROVAL_DEFAULT_MS");
  const broker = createBroker(() => main, capabilities, timeout, defaultMs, () => settings.approvalModel,
    (statement, call, owner, context) => judge(judgeModels(currentModels(), dir, now, owner), taskModel, statement, call, context));
  const taskExtensions = [extension, TaskTools, broker];
  const dispatch = createDispatcher(taskExtensions, taskModel, clock, (requested = thinking.task ?? "high") => {
    const model = currentModels().getModel(taskModel.provider, taskModel.modelId);
    return model ? clampThinkingLevel(model, requested) : requested;
  });
  const time = calendarTime(timeZone);
  const budget = createProactiveBudget(time, proactive.budget, now, dir);
  const heartbeat = registerHeartbeat(scheduler, () => main, memory, () => plugins.find(p => p.capability.id === "calendar"), budget, timeZone, () => settings.heartbeat, now);
  registerGoalReview(scheduler, memory, dispatch, budget, timeZone, () => capabilities.manifests.some(cap => cap.id === "browser"));

  async function updateOffered(tx: Tx, id: ConversationId, lastUsed: Record<string, number>) {
    const offered = tools().filter(tool => {
      const id = capabilities.toolActions.get(tool.name)!.capability;
      return id === "memory" || (leasable(id) && Object.hasOwn(lastUsed, id));
    });
    await configure(tx, id, { modelTools: [...controls, ...offered] });
  }

  const cancellation = createTaskCancellation(() => harness);
  const watches = createWatches(() => main, () => harness, () => plugins, dispatch, cancellation, budget, time, now);
  const controls: ToolRegistration[] = [
    ...scheduler.tools, notifyTool(time), ...watches.tools,
    dispatchTool(dispatch), taskStatus, taskMessage, cancellation.tool,
  ];
  if (leasing) controls.push(
    defineTool({
      name: "enable_tool", description: "Lease a main-leasable capability for direct use.",
      parameters: obj({ capability: str(), reason: str({ minLength: 1 }) }), replay: "safe",
      async execute({ capability }, api, ctx) {
        if (capability === "schedule") return reply("Schedule is always available");
        if (capability === "memory") return reply("Memory is always available");
        if (!leasable(capability)) return reply("Capability is not leasable", true);
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
        (await tx.doc(Heartbeat, runtime.conversationId)).lastActivity = runtime.now();
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
    name: "alter.main", tools: controls,
    sections: [{ key: "memory-index", tag: false, render: (_, ctx) => main.commit(tx => prompt.index(tx, main.id), ctx) }],
    tasks: [SourceBorrow, AdvanceLeases, BackgroundTask, cancellation.stop, watches.worker, watches.poller],
    hooks: [
      hook(BackgroundTask, {
        async onTaskEnd(taskId) {
          const handlers = plugins.flatMap(p => p.onTaskEnd ? [p.onTaskEnd] : []);
          if (!handlers.length) return;
          const task = (await harness.snapshot(Tasks, main.id, context))?.byId[taskId];
          const child = task && await harness.conversation(task.conversationId, context);
          if (child) for (const handler of handlers) await handler(child);
        },
      }),
      hook(GenerationTask, {
        afterRun: () => ({ tasks: [hookTask(AdvanceLeases, null)] }) }),
      hook(ToolTask, { async beforeTool(call, _, ctx) {
        const action = capabilities.toolActions.get(call.name);
        if (!action || action.capability === "memory" || action.capability === "schedule") return;
        return main.commit(async tx => {
          const leases = await tx.doc(Leases, main.id);
          if (!leasable(action.capability) || !Object.hasOwn(leases.lastUsed, action.capability)) return { block: "No active lease" };
          leases.lastUsed[action.capability] = leases.turns + 1;
        }, ctx);
      } }),
    ],
  });
  for (const extension of [...taskExtensions, WatchTools, controlPlane]) registry.install(extension);
  const meteredModels = () => withUsage(currentModels(), budget, dir, now);
  const harness = await Harness.open(storage, {
    models: typeof models === "function" ? meteredModels : meteredModels(),
    registry, now: options.now, setTimer: options.setTimer, settings: { toolExecution: "sequential", retry: { enabled: false } },
  }, context);
  const main: Conversation = await harness.root(context, { agent: {
    extensions: [controlPlane, extension, broker], modelTools: controls,
  } });
  if (options.now) approvalClocks.set(main, options.now);
  // root's agent options only apply on creation. Upgrade M0's model refs before resume,
  // preserving persisted leases and conversational history.
  await main.commit(async tx => {
    await configure(tx, main.id, { extensions: [controlPlane, extension, broker], model: mainModel, thinkingLevel: thinking.main, instructions: mainInstructions });
    const leases = await tx.doc(Leases, main.id);
    for (const id of Object.keys(leases.lastUsed)) if (!leasable(id) && !options.deferredLeases?.includes(id)) delete leases.lastUsed[id];
    await updateOffered(tx, main.id, leases.lastUsed);
    await tx.doc(ProviderDoc, main.id);
    const lastWake = await restoreActivity(tx, now());
    if (lastWake !== undefined) await wakeNotifications(tx, lastWake);
    await migrateRequests(tx, main, now(), timeout);
    const tasks = await tx.doc(Tasks, main.id);
    for (const [id, task] of Object.entries(tasks.byId)) {
      if (task.context === undefined || task.createdAt === undefined) {
        const child = await tx.conversation(task.conversationId);
        task.context ??= child?.parent ? "fork" : "fresh";
        const brief = (await tx.submissionByRequest(task.conversationId, `brief-${id}`))?.entry;
        task.createdAt ??= brief === undefined ? 0 : (await tx.entry(brief))?.model?.[0]?.timestamp ?? 0;
      }
      if (!task.worker) task.worker = (await tx.conversation(task.conversationId))!.owner!.taskId;
      task.thinking ??= (await tx.doc(AgentDoc, task.conversationId)).thinkingLevel ?? "off";
      if (task.status === "running") await configure(tx, task.conversationId, { model: taskModel, thinkingLevel: task.thinking,
        ...(!task.proactive && { instructions: task.watch ? watchInstructions : workerInstructions }) });
    }
  }, context);
  const host: PluginHost = { watching: watches.watching, emit: event => emitEvent(main, event, watches.receive) };
  let stopSchedules: (() => Promise<void>) | undefined;
  let stopEvents: (() => Promise<void>) | undefined;
  let stopConsolidation: (() => Promise<void>) | undefined;
  const stops: (() => Promise<void>)[] = [];
  let closing: Promise<void> | undefined;
  async function shutdown() {
    await stopConsolidation?.();
    await stopEvents?.();
    await stopSchedules?.();
    const results = await Promise.allSettled(stops.reverse().map(async stop => stop()));
    await harness.close(context);
    const errors = results.filter(r => r.status === "rejected").map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, "Plugin shutdown failed");
  }
  try {
    stops.push(await memory.start());
    stops.push(await observeWakes(harness, main, now));
    for (const plugin of plugins) if (plugin !== memory && plugin.start) stops.push(await plugin.start(host));
    stopConsolidation = await startConsolidation(main, harness, memory, meteredModels, taskModel, async (since, until) =>
      (await Promise.all(plugins.flatMap(p => p.ownMessages ? [p.ownMessages(since, until)] : []))).flat(), memoryTurns, timeZone, now, options.setTimer);
    stopSchedules = await schedules.start();
    await scheduler.ensureDaily("digest", "每日摘要", proactive.digestTime);
    await scheduler.ensureDaily("goal-review", "每日目标复查", proactive.goalReviewTime);
    await heartbeat.start(now());
    stops.push(await observeHeartbeatRuns(harness, main, now));
    const classify = createTriage(currentModels, taskModel, memory.summary, budget);
    stopEvents = await startEventBus(harness, main, time, now, proactive.mute, classify);
  } catch (error) {
    await shutdown();
    throw error;
  }
  mainInputContext.set(main, clock);
  async function replacePlugin(id: string, plugin?: AlterPlugin, preserveLease = false) {
    const next = plugins.filter(p => p.capability.id !== id);
    if (plugin) next.push(plugin);
    const updated = createCapabilityRegistry([...next, scheduler], options.demos ?? true);
    plugins = next;
    Object.assign(capabilities, updated);
    registry.install({ ...extension, tools: tools() });
    await main.commit(async tx => {
      const leases = await tx.doc(Leases, main.id);
      if (!preserveLease && !leasable(id)) delete leases.lastUsed[id];
      await updateOffered(tx, main.id, leases.lastUsed);
    }, context);
    if (id === "calendar") {
      await stopSchedules?.();
      stopSchedules = await schedules.start();
    }
  }
  const borrowSource = async (plugin: string, name: string, args: JsonObject, signal: AbortSignal) => {
    const tool = tools().find(t => t.name === name);
    if (!tool) throw new Error("Source borrow requires an enabled capability");
    return borrowForSource(main, harness, [extension, broker], plugin, tool, args, signal, now());
  };
  return { harness, main, settings, replacePlugin, borrowSource, demo, memory, scheduler, schedules, watches, capabilities, now, timeZone, events: host, heartbeat,
    notifications: {
      alert: (source: string, title: string) => main.commit(tx => addNotification(tx, { id: crypto.randomUUID(), at: now(), kind: "notify",
        level: "now", status: "unread", source, title }, time.midnight(now())), context),
      isClaimed: (ref: string) => main.commit(tx => isClaimed(tx, ref), context),
      claim: (ref: string) => main.commit(tx => claim(tx, ref), context),
      delivered: (items: readonly Notification[]) => main.commit(tx => recordDeliveries(tx, items), context),
    }, close: () => closing ??= shutdown() };
}
