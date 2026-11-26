import { startSurface, type AlterSurface } from "./observe.ts";
import { registerUserChannel, type UserChannel } from "./user-channels.ts";
import { NodeHub, nodeSessionsTool } from "./nodes.ts";
import { createFeedback } from "./feedback-service.ts";
import { FeedbackError } from "./feedback.ts";
import { feedbackCall } from "./feedback-model.ts";
import { feedbackPaused, Preferences } from "./feedback-settings.ts";
import { borrowForSource, SourceBorrow } from "./source-borrow.ts";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import { approvalClocks, createBroker, migrateRequests } from "./broker.ts";
import { activeLease, LeaseHistory, Leases, leaseTarget, leaseWindow } from "./leases.ts";
import { judge } from "./approval-model.ts";
import { compactionSettings, mainCompaction } from "./compaction.ts";
import { openSettings } from "./settings.ts";
import { createCapabilityRegistry, createDemoCapabilities, type AlterPlugin, type PluginHost } from "./capabilities.ts";
import {
  AgentDoc, configure, context, createRegistry, defineExtension, defineTask, defineTool,
  GenerationTask, Harness, hook, hookTask, LiveDoc, ProviderDoc, reply, storageDirectories, type Conversation,
  type ConversationId, type EntryId, type HarnessOptions, type ModelRef, type ModelThinkingLevel, type Storage, type JsonObject, type ToolRegistration, type TaskId, type Tx,
} from "./runtime.ts";
import { defaultApprovalTimeoutMs, proactiveConfig, validateApprovalTimeout } from "./config.ts";
import { defaultTimeZone, inputClock } from "./clock.ts";
import { calendarTime } from "./calendar-time.ts";
import { emitEvent, startEventBus } from "./events.ts";
import { observeHeartbeatRuns } from "./heartbeat-runs.ts";
import { digestSummary } from "./digest-summary.ts";
import { registerReports } from "./reports.ts";
import { registerHeartbeat } from "./heartbeat.ts";
import { Heartbeat, restoreActivity } from "./heartbeat-state.ts";
import { addNotification, claim, isClaimed, digestSource, staySilentTool, deliverReply, notificationClocks, recordDeliveries, wakeNotifications, type Notification } from "./notifications.ts";
import { createProactiveBudget } from "./usage.ts";
import { openDebugTraces, type DebugTraces } from "./debug-traces.ts";
import { gatewayCapabilities, auxiliaryModels, tagRequest, withUsage } from "./models.ts";
import { createTriage } from "./triage.ts";
import { consolidationThreshold, startConsolidation } from "./memory-consolidation.ts";
import { memoryPrompt } from "./memory-prompt.ts";
import { createMemory, memoryWriteGuidance } from "./memory.ts";
import { createScheduledTasks } from "./scheduled-tasks.ts";
import { createScheduler } from "./scheduler.ts";
import { consumeReports, hasUserInput, mainInputContext, queuedReports } from "./timeline.ts";
import { activeWake, observeWakes } from "./wake.ts";
import { TaskIdentity, Tasks } from "./state.ts";
import { createWatches, WatchTools, watchInstructions } from "./watch.ts";
import { BackgroundTask, createTaskCancellation, createDispatcher, dispatchTool, taskMessage, taskStatus, workerInstructions, TaskTools } from "./tasks.ts";
import { withStrictToolArguments } from "./tool-validation.ts";

export { Events } from "./events.ts";
export { Leases, leaseWindow } from "./leases.ts";

export async function openAlter(
  storage: Storage, models: HarnessOptions["models"], mainModel: ModelRef, taskModel: ModelRef = mainModel,
  thinking: { main?: ModelThinkingLevel; task?: ModelThinkingLevel } = {},
  options: { memoryConsolidationTurns?: number; dataDir?: string; leasing?: boolean; demos?: boolean; plugins?: AlterPlugin[]; userChannels?: readonly UserChannel[]; surfaces?: readonly AlterSurface[]; deferredLeases?: string[] | true; approvalTimeoutMs?: number; approvalDefaultMs?: number; timeZone?: string; now?: () => number; setTimer?: HarnessOptions["setTimer"] } = {},
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
  const eventSource = (p?: AlterPlugin) => p?.scheduleEvents ?? p?.calendarEvents;
  const eventSources = (providers: AlterPlugin[]) => new Map(providers.flatMap(p => {
    const source = eventSource(p);
    return source ? [[p.capability.id, source] as const] : [];
  }));
  let sources = eventSources(plugins);
  const schedules = createScheduledTasks(() => main, registry, timeZone, now, () => sources,
    () => ({ dispatch, budget, harness, nodes }));
  const scheduler = createScheduler(() => main, registry, timeZone, now, schedules);
  const currentModels = () => typeof models === "function" ? models() : models;
  const dir = gatewayCapabilities.get(currentModels())?.dataDir ?? options.dataDir ?? storageDirectories.get(storage);
  const askFeedback = feedbackCall(() => auxiliaryModels(currentModels(), dir, now, "feedback"), taskModel);
  const feedback = createFeedback(() => main, () => harness, memory, scheduler, now, timeZone, askFeedback, options.dataDir ?? storageDirectories.get(storage));
  const capabilities = createCapabilityRegistry([...plugins, scheduler], options.demos ?? true);
  const demo = createDemoCapabilities(capabilities.activeDemos);
  const available = (describe: (plugin: AlterPlugin) => string) => [
    ...capabilities.activeDemos.filter(cap => demo.tools.some(tool => tool.name.startsWith(cap.id + "_")))
      .map(cap => cap.summary ?? cap.id),
    ...plugins.filter(p => p.capability.actions.length).map(describe)];
  const leaseDescription = ({ capability }: AlterPlugin) => {
    const label = capability.summary ?? capability.id;
    return capability.id === "memory" ? label : label + " [" + capability.actions.map(a => a.name).join(", ") + "]";
  };
  const explorationSources = () => available(({ capability, tools }) => {
    const tool = tools.find(t => capabilities.toolActions.get(t.name)?.effect === "read") ?? tools[0]!;
    const description = tool.description.trim().split(/\n|(?<=[。！？])|(?<=[.!?])\s/, 1)[0] || tool.name;
    return capability.id + " — " + description.slice(0, 120);
  });
  const prompt = memoryPrompt(memory, async tx => "可用能力有 " + available(leaseDescription).join("、") + "。" +
    (leasing ? "一两步、结果短、需要对话上下文或用户正在等时，用 enable_tool 启用；可指定 action 单租只读工具。" : "") + await nodes.prompt(tx));
  const mainInstructions = "你是用户的个人主动型助理，最大的特色是能完成用户现有的目标、尝试用户提到过的事、猜测用户可能需要什么并主动去做，给用户带来惊喜。" +
    "你是 Alter 的主助手，负责与用户对话，默认跟随用户的语言。每条输入的第一行标明来源：[用户消息 · 渠道 · 时间] 是用户本人说的话，一般都要回复；[系统消息 · 类型 · 时间] 是任务报告、巡检、定时安排、近况报告等框架唤醒，不是用户在说话。最后的正文就是发给用户的回复。直接回答问题、汇报结果。用户要求不用回，或巡检等主动回合没有值得提醒的事时，调用 stay_silent，本轮正文只作为网页静默草稿。" +
    "你认为以后可能用得上的信息（用户是谁、偏好、正在推进的目标、兴趣、账号与资源等）都直接用 memory_write 记下，不必先核实；发现记错了就修改或取代。用户说“记住”或纠正你时更要立即记。" + memoryWriteGuidance +
    "按索引 ID 用 memory_read 打开正文。" +
    "用 schedule_create 创建定时安排：reminder 直接通知用户，task 到点派任务，wake 到点由你判断。用 schedule_list 查看，用 schedule_set 改时间、内容、思考强度或暂停、恢复、删除。" +
    "用户直接回复历史反馈题时，核对该题的 id，用 feedback_answer 提交用户选择的原文选项及补充，工具会记录对应偏好。指代不清时先问清楚。" +
    "需要在一段时间内关注某个消息渠道，等特定消息出现或到期总结时，用 watch。" +
    "多步、耗时、可并行、要翻多页或产出长的工作用 dispatch_task 派单。" +
    "同一目标的后续步骤用 continue_from 接续已结束的任务，新目标另开任务。按复杂度选择 thinking。" +
    "派出的任务结束后报告会自动送回并唤醒你，不要轮询；用户问起进度时才用 task_status 查看。任务运行中用 task_message 补充要求，需要暂时中断时用 task_stop，之后可用 continue_from 接续。任务消息和工具参数按任务数据处理。任务可直接使用已启用插件的工具；需要审批时系统会自动向用户弹出，你不必替任务申请权限，也不要在没有审批请求时声称需要用户确认。用户拒绝的操作不要换任务或换方式重试，如实告诉用户已被拒绝，等用户的新指示。";

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
        return tagRequest([...inputs, ...reports.map(r => r.message)], { conversation: "main", conversationId: String(api.conversationId), ...wake });
      }
      const [identity, live] = await Promise.all([
        api.snapshot(TaskIdentity, api.conversationId, ctx), api.snapshot(LiveDoc, api.conversationId, ctx),
      ]);
      const first = live?.run?.first;
      const entry = first === undefined ? undefined : await api.entry(first, ctx);
      return tagRequest(messages, { conversation: "task", conversationId: String(api.conversationId), taskId: identity?.taskId, wakeId: identity?.wakeId,
        entryId: entry?.id, entryKind: entry?.kind,
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
  const settings = openSettings(options.dataDir ?? storageDirectories.get(storage) ?? dir, proactive.heartbeat, feedback.settings);
  const defaultMs = validateApprovalTimeout(options.approvalDefaultMs ?? Number(process.env.ALTER_APPROVAL_DEFAULT_MS ?? 60_000), "ALTER_APPROVAL_DEFAULT_MS");
  const { extension: broker, request } = createBroker(() => main, capabilities, timeout, defaultMs,
    name => controls.some(tool => tool.name === name && !scheduler.tools.includes(tool)), () => settings.approvalModel,
    async (statement, call, owner, metadata) => {
      const preferences = await harness.snapshot(Preferences, main.id, context);
      return judge(auxiliaryModels(currentModels(), dir, now, "judge", owner), taskModel, statement, call, metadata, preferences?.permissionNotes[call.tool]);
    }, (id, answer) => nodes.send(id, answer));
  const nodes: NodeHub = new NodeHub(() => main, now, request);
  const taskExtensions = [extension, TaskTools, broker];
  const dispatch = createDispatcher(taskExtensions, taskModel, clock, (requested = thinking.task ?? "high") => {
    const model = currentModels().getModel(taskModel.provider, taskModel.modelId);
    return model ? clampThinkingLevel(model, requested) : requested;
  }, nodes);
  const time = calendarTime(timeZone);
  const budget = createProactiveBudget(time, proactive.budget, now, dir);
  let traces: DebugTraces;
  const meteredModels = () => withUsage(currentModels(), budget, dir, now, () => traces);
  const reports = registerReports(scheduler, () => main, now, budget, timeZone, proactive.reportTime, () => settings.heartbeat,
    digestSummary(meteredModels, taskModel, now));
  const cancellation = createTaskCancellation(() => harness, nodes);
  const heartbeat = registerHeartbeat(scheduler, () => main, memory, () => plugins.find(p => typeof p.agenda === "function"),
    explorationSources, budget, timeZone, () => settings.heartbeat, now, dispatch, cancellation.cancel);

  async function updateOffered(tx: Tx, id: ConversationId, lastUsed: Record<string, number>) {
    const offered = tools().filter(tool => {
      const { capability, action } = capabilities.toolActions.get(tool.name)!;
      return capability === "memory" || (leasing && activeLease(lastUsed, capability, action));
    });
    await configure(tx, id, { modelTools: [...controls, ...offered] });
  }

  async function restoreLeases(tx: Tx, keepMissing: (id: string) => boolean) {
    const leases = await tx.doc(Leases, main.id);
    const history = await tx.doc(LeaseHistory, main.id);
    for (const key of Object.keys(leases.lastUsed)) {
      const [capability = "", action] = key.split("/");
      const target = leaseTarget(capabilities, capability, action);
      const recordId = leases.records?.[key];
      const record = recordId && history.byId[recordId];
      if (leasing && (target ? !record || target.tools.every(tool => record.tools.includes(tool)) : keepMissing(capability))) continue;
      delete leases.lastUsed[key];
      delete leases.records?.[key];
    }
    await updateOffered(tx, main.id, leases.lastUsed);
  }

  const watches = createWatches(() => main, () => harness, () => plugins, dispatch, cancellation, budget, time, now);
  const controls: ToolRegistration[] = [
    ...scheduler.tools, staySilentTool, digestSource,
    withStrictToolArguments(defineTool({
      name: "feedback_answer", description: "代用户提交已明确回答的反馈题。issueId 为本次出题的 id，options 使用显示的选项原文，other 为用户补充。",
      parameters: obj({ issueId: str({ minLength: 1 }), options: arr(str({ minLength: 1 }), { uniqueItems: true }), other: opt(str({ maxLength: 2000 })) }), replay: "safe",
      async execute({ issueId, options, other }, api, ctx) {
        const fromUser = await api.commit(tx => hasUserInput(tx, api.conversationId), ctx);
        if (!fromUser) return reply("请在用户回复反馈题的对话回合提交。", true);
        try {
          await feedback.answer(issueId, { options, other });
          return reply("已提交反馈。");
        } catch (error) {
          if (error instanceof FeedbackError) return reply(error.message, true);
          throw error;
        }
      },
    }), ({ options, other }) => !options.length && !other?.trim() ? 'provide a selection in "options" or non-empty text in "other"' : undefined),
    ...watches.tools,
    dispatchTool(dispatch, nodes), nodeSessionsTool(nodes), taskStatus, taskMessage(nodes), cancellation.tool,
  ];
  if (leasing) controls.push(
    defineTool({
      name: "enable_tool", description: "Lease an enabled capability or a single action for 30 idle turns.",
      parameters: obj({ capability: str(), action: opt(str()) }), replay: "safe",
      async execute({ capability, action }, api, ctx) {
        if (capability === "schedule") return reply("Schedule is always available");
        if (capability === "memory") return reply("Memory is always available");
        return api.commit(async tx => {
          const target = leaseTarget(capabilities, capability, action);
          if (!target) return reply("Capability is not leasable", true);
          const history = await tx.doc(LeaseHistory, api.conversationId);
          const id = String(api.taskId);
          if (!history.byId[id]) {
            const at = api.now();
            const wake = await activeWake(tx, api.conversationId, at);
            history.byId[id] = { capability, tools: target.tools, reason: "", at, ...(wake && { wakeId: wake.wakeId }),
              approved: false, useWakeIds: [], calls: 0, succeeded: 0, failed: 0, dispatched: false };
            const leases = await tx.doc(Leases, api.conversationId);
            leases.records ??= {};
            leases.records[target.key] = id;
            leases.lastUsed[target.key] = leases.turns + 1;
            await updateOffered(tx, api.conversationId, leases.lastUsed);
          }
          return reply(`Enabled ${target.key}`);
        }, ctx);
      },
    }),
  );

  // Keep the persisted task name and null input for runs created before reply-by-default.
  const FinishMainTurn = defineTask<{ first: EntryId; answer: EntryId } | null, { phase: "advance" }, null>({
    name: "alter.advance-leases", version: 1, initial: () => ({ phase: "advance" }),
    phases: {
      advance: ({ input }, runtime, ctx) => runtime.commit(async tx => {
        if (input) await deliverReply(tx, input.first, input.answer, runtime.now());
        const leases = await tx.doc(Leases, runtime.conversationId);
        (await tx.doc(Heartbeat, runtime.conversationId)).lastActivity = runtime.now();
        leases.turns++;
        for (const [id, last] of Object.entries(leases.lastUsed)) {
          if (leases.turns - last >= leaseWindow) {
            delete leases.lastUsed[id];
            delete leases.records?.[id];
          }
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
    tasks: [nodes.worker, SourceBorrow, FinishMainTurn, BackgroundTask, heartbeat.review, cancellation.stop, watches.worker, watches.poller],
    hooks: [
      mainCompaction(memory, mainModel),
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
        afterRun: ({ first, answer }) => ({ tasks: [hookTask(FinishMainTurn, { first, answer })] }) }),
    ],
  });
  // Apply the same pre-coercion gate to every registration, including raw adapter
  // schemas and tools installed after startup. Agent configuration stores names only.
  const installTools = (ext: typeof extension) => registry.install({
    ...ext, ...(ext.tools && { tools: ext.tools.map(tool => withStrictToolArguments(tool)) }),
  });
  for (const extension of [...taskExtensions, WatchTools, controlPlane]) installTools(extension);
  const harness = await Harness.open(storage, {
    models: typeof models === "function" ? meteredModels : meteredModels(),
    registry, now: options.now, setTimer: options.setTimer, settings: () => ({ toolExecution: "sequential", retry: { enabled: false },
      compaction: compactionSettings(currentModels(), [mainModel, taskModel], settings.compactAtTokens) }),
  }, context);
  const main: Conversation = await harness.root(context, { agent: {
    extensions: [controlPlane, extension, broker], modelTools: controls,
  } });
  notificationClocks.set(main, now);
  if (options.now) approvalClocks.set(main, options.now);
  // root's agent options only apply on creation. Upgrade M0's model refs before resume,
  // preserving persisted leases and conversational history.
  await main.commit(async tx => {
    await configure(tx, main.id, { extensions: [controlPlane, extension, broker], model: mainModel, thinkingLevel: thinking.main, instructions: mainInstructions });
    await restoreLeases(tx, id => options.deferredLeases === true || !!options.deferredLeases?.includes(id));
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
      if (!task.runner && task.status === "running") await configure(tx, task.conversationId, { model: taskModel, thinkingLevel: task.thinking,
        ...(!task.proactive && { instructions: task.watch ? watchInstructions : workerInstructions }) });
    }
  }, context);
  const host: PluginHost = { watching: watches.watching, emit: event => emitEvent(main, event, watches.receive) };
  let stopSchedules: (() => Promise<void>) | undefined;
  let stopEvents: (() => Promise<void>) | undefined;
  let stopFeedback: (() => Promise<void>) | undefined;
  let consolidation: Awaited<ReturnType<typeof startConsolidation>>;
  const stops: (() => Promise<void>)[] = [];
  let closing: Promise<void> | undefined;
  let traceObserver: ReturnType<DebugTraces["observe"]> | undefined;
  async function shutdown() {
    await consolidation?.stop();
    await stopEvents?.();
    await stopSchedules?.();
    await stopFeedback?.();
    const results = await Promise.allSettled(stops.reverse().map(async stop => stop()));
    try { await harness.close(context); }
    finally { traceObserver?.detach(); traces?.close(); }
    const errors = results.filter(r => r.status === "rejected").map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, "Plugin shutdown failed");
  }
  try {
    stops.push(await memory.start());
    traces = openDebugTraces(options.dataDir ?? storageDirectories.get(storage) ?? dir, now);
    traceObserver = traces.observe(harness);
    stopFeedback = await feedback.start();
    stops.push(await observeWakes(harness, main, now));
    for (const plugin of plugins) if (plugin !== memory && plugin.start) stops.push(await plugin.start(host));
    consolidation = await startConsolidation(main, harness, memory, meteredModels, taskModel, async (since, until) =>
      (await Promise.all(plugins.flatMap(p => p.ownMessages ? [p.ownMessages(since, until)] : []))).flat(), memoryTurns, timeZone, now, options.setTimer);
    await scheduler.migrate();
    stopSchedules = await schedules.start();
    stops.push(await reports.start(harness, () => heartbeat.start(now())));
    await heartbeat.start(now());
    stops.push(await observeHeartbeatRuns(harness, main, now));
    const classify = createTriage(currentModels, taskModel, memory.summary, budget);
    stopEvents = await startEventBus(harness, main, now, proactive.mute, classify);
  } catch (error) {
    await shutdown();
    throw error;
  }
  mainInputContext.set(main.id, clock);
  async function replace(id: string, plugin?: AlterPlugin, preserveLease = false) {
    const previous = plugins.find(p => p.capability.id === id);
    const next = plugins.filter(p => p.capability.id !== id);
    if (plugin) next.push(plugin);
    const updated = createCapabilityRegistry([...next, scheduler], options.demos ?? true);
    const rebindEvents = !!(eventSource(previous) || eventSource(plugin));
    if (rebindEvents) await stopSchedules?.();
    plugins = next;
    if (rebindEvents) sources = eventSources(plugins);
    Object.assign(capabilities, updated);
    installTools({ ...extension, tools: tools() });
    await main.commit(tx => restoreLeases(tx, cap => cap !== id || preserveLease), context);
    if (rebindEvents) stopSchedules = await schedules.start();
  }
  // Registrations from different managers can overlap. Rebind schedule listeners once per replacement.
  let replacing = Promise.resolve();
  function replacePlugin(id: string, plugin?: AlterPlugin, preserveLease = false) {
    const work = replacing.then(() => replace(id, plugin, preserveLease));
    replacing = work.catch(() => {});
    return work;
  }
  const borrowSource = async (plugin: string, name: string, args: JsonObject, signal: AbortSignal) => {
    const tool = tools().find(t => t.name === name);
    if (!tool) throw new Error("Source borrow requires an enabled capability");
    return borrowForSource(main, harness, [extension, broker], plugin, tool, args, signal, now());
  };
  const finishPluginRegistration = () => main.commit(tx => restoreLeases(tx, () => false), context);
  async function debugSchedule() {
    const [inspection, report, scheduledTasks, memory, watch, timers] = await Promise.all([
      heartbeat.debug(), reports.schedule(), schedules.schedule(), consolidation.schedule(), watches.schedule(), scheduler.list(),
    ]);
    const checkin = timers.find(item => item.kind === "feedback" && item.status === "scheduled");
    return { timeZone, heartbeat: inspection, report, scheduledTasks, memory, watch,
      feedback: { paused: !checkin, nextAt: checkin?.at ?? null, reason: feedbackPaused ? "每周回访功能已暂停。"
        : "通常每七天回访，连续两批全部跳过后延长到十四天。" } };
  }
  const app = { registerUserChannel: (channel: UserChannel) => registerUserChannel(main, channel), harness, main, settings, traces, debugSchedule, nodes,
    get modelCapabilities() { return gatewayCapabilities.get(currentModels()); },
    feedback, replacePlugin, finishPluginRegistration, borrowSource, demo, memory, scheduler, schedules, watches, capabilities, now, timeZone, events: host, heartbeat, reports,
    notifications: {
      alert: (source: string, title: string) => main.commit(tx => addNotification(tx, { id: crypto.randomUUID(), at: now(), kind: "notify",
        level: "now", status: "unread", source, title }), context),
      isClaimed: (ref: string) => main.commit(tx => isClaimed(tx, ref), context),
      claim: (ref: string) => main.commit(tx => claim(tx, ref), context),
      delivered: (items: readonly Notification[]) => main.commit(tx => recordDeliveries(tx, items), context),
    }, close: () => closing ??= shutdown() };
  try {
    for (const channel of options.userChannels ?? []) registerUserChannel(main, channel);
    for (const surface of options.surfaces ?? []) stops.push(await startSurface(app, surface));
  } catch (error) { await app.close(); throw error; }
  return app;
}
