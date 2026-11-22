import { randomUUID } from "node:crypto";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import { calendarTime, dailyMinutes } from "./calendar-time.ts";
import type { Capability } from "./capabilities.ts";
import { addNotification, digestDay, Notifications } from "./notifications.ts";
import {
  context, conversationDoc, createRegistry, defineExtension, defineSignal, defineTask, defineTool, reply,
  ROOT_CONVERSATION_ID, type Conversation, type TaskId, type Tx,
} from "./runtime.ts";

export type ScheduleItem = {
  id: string; kind: string; text: string; at: number; repeat?: { daily: string }; createdAt: number;
  status: "scheduled" | "done" | "cancelled";
};
// Handlers commit their durable effects through tx, together with the occurrence checkpoint.
type Handler = (item: Readonly<ScheduleItem>, tx: Tx, firedAt: number) => void | Promise<void>;
const Schedules = conversationDoc<{ byId: Record<string, { item: ScheduleItem; worker: TaskId }> }>("schedules", () => ({ byId: {} }));
const Cancel = defineSignal({ name: "alter.schedule-cancel", version: 1, schema: bool() });
const complete = { status: "terminal", outcome: { status: "completed", result: null } } as const;

export function createScheduler(main: () => Conversation, registry: ReturnType<typeof createRegistry>, timeZone: string, now: () => number) {
  const time = calendarTime(timeZone);
  function taskFor(kind: string, handler: Handler) {
    return defineTask<string, { phase: "tick" }, null>({
      name: `alter.schedule.${kind}`, version: 1, initial: () => ({ phase: "tick" }),
      phases: {
        tick: ({ input: id }, runtime, ctx) => runtime.commit(async tx => {
          const { item } = (await tx.doc(Schedules, ROOT_CONVERSATION_ID)).byId[id]!;
          if (item.status !== "scheduled") return complete;
          const firedAt = runtime.now();
          if (item.at <= firedAt) {
            await handler({ ...item }, tx, firedAt);
            if (!item.repeat) { item.status = "done"; return complete; }
            item.at = time.nextDaily(firedAt, item.repeat.daily);
          }
          return { status: "sleeping", until: item.at, checkpoint: { phase: "tick" }, signals: [Cancel.key(String(item.at))] };
        }, ctx).catch(async error => {
          if (runtime.signal.aborted) throw error;
          console.warn(`Alter schedule ${id} failed, retrying in one minute:`, error);
          await runtime.sleepUntil(runtime.now() + 60_000, { phase: "tick" }, ctx);
        }),
      },
      abort: ({ input: id }, runtime, ctx) => runtime.commit(async tx => {
        (await tx.doc(Schedules, ROOT_CONVERSATION_ID)).byId[id]!.item.status = "cancelled";
        return { status: "terminal", outcome: { status: "aborted" } };
      }, ctx),
    });
  }
  const tasks = new Map<string, ReturnType<typeof taskFor>>();
  function register(kind: string, handler: Handler) {
    if (!kind.trim() || tasks.has(kind)) throw new Error(`Invalid or duplicate schedule kind: ${kind}`);
    const task = taskFor(kind, handler);
    registry.install(defineExtension({ name: task.definition.name, tasks: [task] }));
    tasks.set(kind, task);
  }

  register("reminder", async (item, tx, firedAt) => {
    await addNotification(tx, { id: `${item.id}-${item.at}`, at: firedAt, kind: "reminder", level: time.quietHours(firedAt) ? "digest" : "now",
      title: "提醒", body: item.text, source: "schedule", status: "unread" }, time.midnight(firedAt));
  });

  register("digest", async (item, tx, firedAt) => {
    const { entries } = await tx.doc(Notifications, ROOT_CONVERSATION_ID);
    const midnight = time.midnight(firedAt);
    if (item.repeat && time.nextDaily(midnight - 1, item.repeat.daily) > firedAt) return;
    const state = await digestDay(tx, midnight);
    if (state.sent) return;
    const items = [...state.overflow, ...[...entries].reverse()]
      .filter(n => n.level === "digest" && n.status === "unread" && n.at >= midnight && n.at <= firedAt);
    if (!items.length) return;
    state.sent = true;
    state.overflow = [];
    await addNotification(tx, {
      id: `${item.id}-${item.at}`, at: firedAt, kind: "digest", level: "now", source: "schedule", status: "unread",
      title: `今日摘要（${items.length} 条）`, body: items.map(n => `• [${n.source}] ${[n.title, n.body].filter(Boolean).join(" — ")}`).join("\n"),
    }, midnight);
  });

  type Input = { kind: string; text: string; at: string; daily?: string };
  async function create({ kind, text, at, daily }: Input, id: string = randomUUID()) {
    const task = tasks.get(kind);
    if (!task) throw new Error(`Unknown schedule kind: ${kind}`);
    if (!text.trim()) throw new Error("Expected non-empty text");
    const ms = time.parse(at).ms;
    if (daily !== undefined) dailyMinutes(daily);
    return main().commit(async tx => {
      const { byId } = await tx.doc(Schedules, ROOT_CONVERSATION_ID);
      if (!Object.hasOwn(byId, id)) {
        const worker = await tx.createTask(task, id, { ownership: { kind: "conversation" }, background: true });
        byId[id] = { worker, item: { id, kind, text, at: ms, ...(daily && { repeat: { daily } }), createdAt: now(), status: "scheduled" } };
      }
      return id;
    }, context);
  }
  async function ensureDigest(daily: string) {
    const exists = await main().commit(async tx => {
      const { byId } = await tx.doc(Schedules, ROOT_CONVERSATION_ID);
      const managed = byId["daily-digest"];
      if (managed?.item.status === "scheduled" && managed.item.repeat?.daily !== daily) {
        await tx.signal(managed.worker, Cancel, String(managed.item.at), true);
        managed.item.at = time.nextDaily(now(), daily);
        managed.item.repeat = { daily };
      }
      return Object.values(byId).some(({ item }) => item.kind === "digest");
    }, context);
    if (exists) return;
    await create({ kind: "digest", text: "每日摘要", daily, at: new Date(time.nextDaily(now(), daily)).toISOString() }, "daily-digest");
  }
  function list() {
    return main().commit(async tx => Object.values((await tx.doc(Schedules, ROOT_CONVERSATION_ID)).byId)
      .map(({ item }) => ({ ...item, ...(item.repeat && { repeat: { ...item.repeat } }) })), context);
  }
  function cancel(id: string) {
    return main().commit(async tx => {
      const { byId } = await tx.doc(Schedules, ROOT_CONVERSATION_ID);
      if (!Object.hasOwn(byId, id)) return false;
      const { item, worker } = byId[id]!;
      if (item.status === "scheduled") {
        await tx.signal(worker, Cancel, String(item.at), true);
        item.status = "cancelled";
      }
      return item.status === "cancelled";
    }, context);
  }

  const capability: Capability = { id: "schedule", mainLeasable: false, actions: [
    { name: "create", effect: "write-local", guarded: true }, { name: "list", effect: "read" },
    { name: "cancel", effect: "write-local", guarded: true },
  ] };
  const tools = [
    defineTool({ name: "schedule_create", description: "Set a reminder. at is the first ISO date-time (local unless qualified). daily repeats at local HH:mm.",
      parameters: obj({ text: str({ pattern: "\\S" }), at: str(), daily: opt(str()) }), replay: "safe",
      execute: async (args, api) => reply(await create({ ...args, kind: "reminder" }, `schedule-${api.taskId}`)) }),
    defineTool({ name: "schedule_list", description: "List reminders and their IDs, next times and statuses.",
      parameters: obj({}), replay: "safe", execute: async () => reply(JSON.stringify(await list())) }),
    defineTool({ name: "schedule_cancel", description: "Cancel a scheduled reminder by ID.", parameters: obj({ id: str() }), replay: "safe",
      execute: async ({ id }) => await cancel(id) ? reply(id) : reply("Unknown or finished schedule", true) }),
  ];
  return { register, ensureDigest, create: (input: Input) => create(input), list, cancel, capability, tools };
}
