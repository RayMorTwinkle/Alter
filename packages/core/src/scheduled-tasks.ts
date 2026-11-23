import { randomUUID } from "node:crypto";
import { arr, bool, compile, int, lit, num, obj, oneOf, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { calendarTime } from "./calendar-time.ts";
import type { AlterPlugin, Capability } from "./capabilities.ts";
import {
  context, conversationDoc, createRegistry, defineExtension, defineSignal, defineTask, defineTool, reply,
  ROOT_CONVERSATION_ID as root, type Conversation, type Harness, type TaskId, type Tx,
} from "./runtime.ts";
import { addNotification } from "./notifications.ts";
import type { ScheduleItem } from "./scheduler.ts";
import { submitWake } from "./timeline.ts";
import { TaskIdentity, Tasks } from "./state.ts";
import type { createDispatcher } from "./tasks.ts";
import { budgetExhausted, type ProactiveBudget } from "./usage.ts";

const text = str({ pattern: "\\S" });
const minute = 60_000;
const trigger = union([
  obj({ kind: lit("at"), at: str() }),
  obj({ kind: lit("every"), minutes: num({ minimum: 5 }) }),
  obj({ kind: lit("daily"), time: str(), weekdays: opt(arr(int({ minimum: 0, maximum: 6 }), { minItems: 1 })) }),
  obj({ kind: lit("event"), eventId: text, offsetMinutes: num(), anchor: oneOf(["start", "end"]) }),
]);
const parameters = obj({ brief: text, trigger, type: oneOf(["reminder", "task", "wake"]),
  continue_from: opt(text), thinking: opt(oneOf(["low", "medium", "high", "max"])) });
const changes = obj({ id: text, trigger: opt(trigger), brief: opt(text),
  thinking: opt(oneOf(["low", "medium", "high", "max"])), status: opt(oneOf(["active", "paused", "deleted"])) });
const changeSchema = compile(changes);
const inputSchema = compile(parameters);
type Input = Static<typeof parameters>;
export type ScheduledTask = Input & {
  action?: Input["type"]; id: string; createdAt: number; nextAt: number | null; paused: boolean;
  lastRun?: { dueAt: number; at: number; missed: boolean; skipped?: string; taskId?: string };
};
type Row = { item: ScheduledTask; worker: TaskId; wakeKey?: string };
export const ScheduledTasks = conversationDoc<{ byId: Record<string, Row>; removed: Record<string, true> }>(
  "scheduled-tasks", () => ({ byId: {}, removed: {} }),
);
const Changed = defineSignal({ name: "alter.scheduled-task-changed", version: 1, schema: bool() });
const complete = { status: "terminal", outcome: { status: "completed", result: null } } as const;
type Services = { harness: Harness; dispatch: ReturnType<typeof createDispatcher>; budget: ProactiveBudget };

function timestamp(ms: number) {
  if (!Number.isSafeInteger(ms) || !Number.isFinite(new Date(ms).getTime())) throw new Error("Trigger time is out of range");
  return ms;
}

export function createScheduledTasks(main: () => Conversation, registry: ReturnType<typeof createRegistry>, timeZone: string,
  now: () => number, getCalendar: () => AlterPlugin["calendarEvents"], services: () => Services) {
  const time = calendarTime(timeZone);
  const openedAt = now();
  function next(trigger: Input["trigger"], after: number, base: number) {
    switch (trigger.kind) {
      case "at": return time.parse(trigger.at).ms;
      case "every": {
        const period = Math.round(trigger.minutes * minute);
        return timestamp(base + (Math.floor((after - base) / period) + 1) * period);
      }
      case "daily": return time.nextDaily(after, trigger.time, trigger.weekdays);
      case "event": {
        const calendar = getCalendar();
        if (!calendar) throw new Error("Calendar is unavailable");
        const event = calendar.get(trigger.eventId);
        return event ? timestamp(event[trigger.anchor] + Math.round(trigger.offsetMinutes * minute)) : null;
      }
    }
  }
  async function signal(tx: Tx, row: Row) {
    if (row.wakeKey) await tx.signal(row.worker, Changed, row.wakeKey, true);
  }
  async function setEventTime(tx: Tx, item: ScheduledTask, due: number | null) {
    if (due === null) {
      const doc = await tx.doc(ScheduledTasks, root);
      delete doc.byId[item.id];
      doc.removed[item.id] = true;
      await tx.appendEntry(root, { kind: "alter.schedule-notice",
        data: { at: now(), text: `绑定日程已删除，定时任务已取消：${item.brief}` } });
    } else item.nextAt = due;
  }

  async function fire(tx: Tx, item: ScheduledTask, dueAt: number, at: number) {
    const missed = dueAt < openedAt || at - dueAt >= minute;
    const run: NonNullable<ScheduledTask["lastRun"]> = { dueAt, at, missed };
    const { budget, dispatch } = services();
    if (item.type === "reminder") {
      await addNotification(tx, { id: `${item.id}-${dueAt}`, at, kind: "reminder", level: time.quietHours(at) ? "digest" : "now",
        title: "提醒", body: item.brief, source: "schedule", status: "unread" });
    } else if (!await budget.available(at)) run.skipped = budgetExhausted;
    else if (item.type === "wake") {
      const content = `[主会话自己的定时安排${missed ? " · missed 补跑" : ""}]\n${item.brief}`;
      await submitWake(tx, main(), { id: `wake-${item.id}-${dueAt}`, kind: "alter.schedule", at, content,
        data: { scheduleId: item.id, at, dueAt, missed, text: content, ...(item.thinking && { thinking: item.thinking }) } });
    } else {
      const tasks = (await tx.doc(Tasks, root)).byId;
      const previous = item.continue_from && Object.hasOwn(tasks, item.continue_from) ? tasks[item.continue_from] : undefined;
      if (item.continue_from && !previous) run.skipped = "接续任务不存在";
      if (previous) {
        const identity = await tx.doc(TaskIdentity, previous.conversationId);
        const latest = tasks[identity.taskId]!;
        if (latest.status === "running") run.skipped = "接续任务仍在运行";
        else if ((await tx.task(latest.worker))?.state.status !== "terminal") return latest.worker;
      }
      if (!run.skipped) {
        run.taskId = `task-${item.id}-${dueAt}`;
        const brief = missed ? "[定时任务 · missed 补跑]\n" + item.brief : item.brief;
        await dispatch(tx, root, run.taskId, { brief, thinking: item.thinking, triggerSource: "scheduled",
          context: previous?.context ?? "fresh", permission: previous?.permission ?? "restricted", continuedFrom: item.continue_from });
      }
    }
    item.lastRun = run;
    item.nextAt = item.trigger.kind === "daily" || item.trigger.kind === "every" ? next(item.trigger, at, item.createdAt) : null;
  }

  const worker = defineTask<string, { phase: "tick" }, null>({
    name: "alter.scheduled-task", version: 1, initial: () => ({ phase: "tick" }),
    phases: { tick: ({ input: id }, runtime, ctx) => runtime.commit(async tx => {
      const doc = await tx.doc(ScheduledTasks, root);
      const row = doc.byId[id];
      if (!row || row.worker !== runtime.taskId) return complete;
      const item = row.item;
      item.type ??= item.action!;
      const at = runtime.now();
      const calendar = getCalendar();
      if (calendar && item.trigger.kind === "event" && item.nextAt !== null) {
        const due = next(item.trigger, at, item.createdAt);
        if (due !== item.nextAt) await setEventTime(tx, item, due);
        if (due === null) return complete;
      }
      const active = !item.paused && (item.trigger.kind !== "event" || !!calendar);
      if (active && item.nextAt !== null && item.nextAt <= at) {
        const settling = await fire(tx, item, item.nextAt, at);
        if (settling) return { status: "waiting", on: [settling], policy: "allSettled", checkpoint: { phase: "tick" } };
      }
      if (item.nextAt === null) return complete;
      row.wakeKey = randomUUID();
      return { status: "sleeping", ...(active && { until: item.nextAt }), checkpoint: { phase: "tick" },
        signals: [Changed.key(row.wakeKey)] };
    }, ctx).catch(async error => {
      if (runtime.signal.aborted) throw error;
      console.warn(`Scheduled task ${id} failed, retrying in one minute`, error);
      await runtime.sleepUntil(runtime.now() + minute, { phase: "tick" }, ctx);
    }) },
    abort: (_, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  registry.install(defineExtension({ name: worker.definition.name, tasks: [worker] }));

  async function create(input: Input, id: string = randomUUID()) {
    if (!inputSchema.check(input)) throw new Error("Invalid scheduled task");
    if (input.type !== "task" && input.continue_from) throw new Error("continue_from requires type task");
    return main().commit(async tx => {
      const { byId, removed } = await tx.doc(ScheduledTasks, root);
      if (Object.hasOwn(byId, id) || Object.hasOwn(removed, id)) return id;
      if (input.continue_from && !Object.hasOwn((await tx.doc(Tasks, root)).byId, input.continue_from)) throw new Error("Unknown task");
      const createdAt = now();
      const nextAt = next(input.trigger, createdAt, createdAt);
      if (nextAt === null) throw new Error("Unknown or deleted event");
      const task = await tx.createTask(worker, id, { ownership: { kind: "conversation" }, background: true });
      byId[id] = { worker: task, item: { ...input, action: input.type, id, paused: false, nextAt, createdAt } };
      return id;
    }, context);
  }
  async function list() {
    const doc = await services().harness.snapshot(ScheduledTasks, root, context);
    return Object.values(doc?.byId ?? {}).map(row => row.item);
  }
  function set(patch: Static<typeof changes>) {
    if (!changeSchema.check(patch) || Object.keys(patch).length === 1) throw new Error("Invalid schedule changes");
    return main().commit(async tx => {
      const { byId, removed } = await tx.doc(ScheduledTasks, root);
      const { id, status, brief, trigger, thinking } = patch;
      if (!Object.hasOwn(byId, id)) return false;
      const row = byId[id]!;
      const item = row.item;
      if (status === "deleted") {
        await signal(tx, row);
        delete byId[id];
        removed[id] = true;
        return true;
      }
      if (item.nextAt === null && !trigger) return false;
      const resumed = item.paused && status === "active";
      const at = now();
      if (trigger || (resumed && (item.trigger.kind === "every" || item.trigger.kind === "daily"))) {
        const due = next(trigger ?? item.trigger, at, item.createdAt);
        if (due === null) throw new Error("Unknown or deleted event");
        await signal(tx, row);
        if (item.nextAt === null) {
          row.worker = await tx.createTask(worker, id, { ownership: { kind: "conversation" }, background: true });
          delete row.wakeKey;
        }
        item.nextAt = due;
      } else if (status && item.paused !== (status === "paused")) await signal(tx, row);
      if (trigger) item.trigger = trigger;
      if (status) item.paused = status === "paused";
      if (brief !== undefined) item.brief = brief;
      if (thinking) item.thinking = thinking;
      return true;
    }, context);
  }
  async function importReminder(tx: Tx, item: ScheduleItem) {
    const { byId, removed } = await tx.doc(ScheduledTasks, root);
    if (item.status === "cancelled") { removed[item.id] = true; return; }
    if (byId[item.id] || removed[item.id]) return;
    const trigger: Input["trigger"] = item.repeat ? { kind: "daily", time: item.repeat.daily } : { kind: "at", at: new Date(item.at).toISOString() };
    const task = await tx.createTask(worker, item.id, { ownership: { kind: "conversation" }, background: true });
    byId[item.id] = { worker: task, item: { type: "reminder", action: "reminder", id: item.id, brief: item.text, trigger,
      createdAt: item.createdAt, nextAt: item.status === "done" ? null : item.at, paused: false } };
  }
  async function start() {
    const calendar = getCalendar();
    function sync(eventId?: string, deleted = false) {
      return main().commit(async tx => {
        const { byId } = await tx.doc(ScheduledTasks, root);
        const changes = [];
        for (const row of Object.values(byId)) {
          row.item.type ??= row.item.action!;
          const { trigger, nextAt, createdAt } = row.item;
          if (trigger.kind !== "event" || nextAt === null || (eventId && eventId !== trigger.eventId)) continue;
          const due = deleted ? null : calendar ? next(trigger, now(), createdAt) : nextAt;
          if (!eventId || due !== nextAt) changes.push({ row, due });
        }
        // Admit every signal read before the first table write, including timeline entries.
        await Promise.all(changes.map(({ row }) => signal(tx, row)));
        for (const { row, due } of changes) if (due !== row.item.nextAt) await setEventTime(tx, row.item, due);
      }, context);
    }
    let pending = Promise.resolve();
    const stop = calendar?.subscribe(id => {
      pending = sync(id, !calendar.get(id)).catch(error => console.error("Schedule calendar refresh failed", error));
    });
    try { await sync(); } catch (error) { stop?.(); throw error; }
    return async () => { stop?.(); await pending; };
  }
  const actions: Capability["actions"] = [
    { name: "create", effect: "write-local", guarded: true }, { name: "list", effect: "write-local" },
    { name: "set", effect: "write-local", guarded: true },
  ];
  const tools = [
    defineTool({ name: "schedule_create", description: "Create a reminder (notify directly), task (dispatch a worker), or wake (ask main). Only task accepts continue_from. Event offsets are signed minutes.",
      parameters, replay: "safe", execute: async (args, api) => reply(await create(args, `scheduled-${api.taskId}`)) }),
    defineTool({ name: "schedule_list", description: "List all schedules with IDs, types and next times.", parameters: obj({}), replay: "safe",
      execute: async () => reply(JSON.stringify(await list())) }),
    defineTool({ name: "schedule_set", description: "Edit the trigger, brief or thinking, pause, resume or delete a schedule by ID.",
      parameters: changes, replay: "safe", execute: async args => await set(args) ? reply(args.id) : reply("Unknown or finished schedule", true) }),
  ];
  return { create, list, set, importReminder, start, actions, tools,
    pause: (id: string, paused: boolean) => set({ id, status: paused ? "paused" : "active" }),
    cancel: (id: string) => set({ id, status: "deleted" }) };
}
