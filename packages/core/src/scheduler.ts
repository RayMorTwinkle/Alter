import { randomUUID } from "node:crypto";
import { bool } from "@earendil-works/pi-schema";
import { calendarTime, dailyMinutes } from "./calendar-time.ts";
import type { Capability } from "./capabilities.ts";
import { addNotification } from "./notifications.ts";
import {
  context, conversationDoc, createRegistry, defineExtension, defineSignal, defineTask,
  ROOT_CONVERSATION_ID, type Conversation, type TaskId, type ToolRegistration, type Tx,
} from "./runtime.ts";

export type ScheduleItem = {
  id: string; kind: string; text: string; at: number; repeat?: { daily: string }; createdAt: number;
  status: "scheduled" | "done" | "cancelled";
};
// Handlers commit their durable effects through tx, together with the occurrence checkpoint.
type NextOccurrence = { nextAt: number };
type Handler = (item: Readonly<ScheduleItem>, tx: Tx, firedAt: number) => void | NextOccurrence | Promise<void | NextOccurrence>;
export const Schedules = conversationDoc<{ byId: Record<string, { item: ScheduleItem; worker: TaskId; window?: string }>; retiring?: Record<string, TaskId[]> }>("schedules", () => ({ byId: {} }));
const Cancel = defineSignal({ name: "alter.schedule-cancel", version: 1, schema: bool() });
const complete = { status: "terminal", outcome: { status: "completed", result: null } } as const;

export function createScheduler(main: () => Conversation, registry: ReturnType<typeof createRegistry>, timeZone: string, now: () => number,
  scheduled: { importReminder(tx: Tx, item: ScheduleItem): Promise<void>; tools: ToolRegistration[]; actions: Capability["actions"] }) {
  const time = calendarTime(timeZone);
  function taskFor(kind: string, handler: Handler) {
    return defineTask<string, { phase: "tick" }, null>({
      name: `alter.schedule.${kind}`, version: 1, initial: () => ({ phase: "tick" }),
      phases: {
        tick: ({ input: id }, runtime, ctx) => runtime.commit(async tx => {
          const row = (await tx.doc(Schedules, ROOT_CONVERSATION_ID)).byId[id];
          if (!row) return complete;
          const { item, worker } = row;
          if (worker !== runtime.taskId || item.status !== "scheduled") return complete;
          const firedAt = runtime.now();
          if (item.at <= firedAt) {
            const next = await handler({ ...item }, tx, firedAt);
            if (next && typeof next === "object" && "nextAt" in next) {
              if (!Number.isSafeInteger(next.nextAt) || next.nextAt <= firedAt) throw new Error("Expected a future schedule time");
              item.at = next.nextAt;
            } else if (item.repeat) item.at = time.nextDaily(firedAt, item.repeat.daily);
            else { item.status = "done"; return complete; }
          }
          return { status: "sleeping", until: item.at, checkpoint: { phase: "tick" }, signals: [Cancel.key(String(item.at))] };
        }, ctx).catch(async error => {
          if (runtime.signal.aborted) throw error;
          console.warn(`Alter schedule ${id} failed, retrying in one minute:`, error);
          await runtime.sleepUntil(runtime.now() + 60_000, { phase: "tick" }, ctx);
        }),
      },
      abort: ({ input: id }, runtime, ctx) => runtime.commit(async tx => {
        const entry = (await tx.doc(Schedules, ROOT_CONVERSATION_ID)).byId[id]!;
        if (entry?.worker === runtime.taskId) entry.item.status = "cancelled";
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
      title: "提醒", body: item.text, source: "schedule", status: "unread" });
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
  async function migrate() {
    const legacy = await main().commit(async tx => {
      const doc = await tx.doc(Schedules, ROOT_CONVERSATION_ID);
      const rows = Object.values(doc.byId).filter(({ item }) => ["digest", "goal-review", "reminder"].includes(item.kind));
      for (const [kind, ids] of Object.entries(doc.retiring ?? {})) {
        const live = [];
        for (const id of ids) if ((await tx.task(id))?.state.status !== "terminal") live.push(id);
        if (live.length) doc.retiring![kind] = live;
        else delete doc.retiring![kind];
      }
      return { rows: rows.map(({ item }) => ({ id: item.id, kind: item.kind })),
        kinds: [...new Set([...Object.keys(doc.retiring ?? {}), ...rows.map(({ item }) => item.kind)])] };
    }, context);
    for (const kind of legacy.kinds) if (!tasks.has(kind)) {
      // A legacy sleeper may still be settling after a migration and restart.
      const worker = taskFor(kind, () => {});
      registry.install(defineExtension({ name: worker.definition.name, tasks: [worker] }));
    }
    for (const item of legacy.rows) {
      await main().commit(async tx => {
        const doc = await tx.doc(Schedules, ROOT_CONVERSATION_ID);
        const row = doc.byId[item.id];
        if (!row) return;
        if (row.item.status === "scheduled") await tx.signal(row.worker, Cancel, String(row.item.at), true);
        if (item.kind === "reminder") await scheduled.importReminder(tx, row.item);
        else {
          doc.retiring ??= {};
          doc.retiring[item.kind] = [...(doc.retiring[item.kind] ?? []), row.worker];
        }
        delete doc.byId[item.id];
      }, context);
    }
  }
  async function ensureAdaptive(kind: string, text: string, first: number | undefined, window = "", reset = false) {
    const id = `adaptive-${kind}`;
    await main().commit(async tx => {
      const { byId } = await tx.doc(Schedules, ROOT_CONVERSATION_ID);
      const existing = byId[id];
      if (first === undefined) {
        if (existing?.item.status === "scheduled") {
          await tx.signal(existing.worker, Cancel, String(existing.item.at), true);
          existing.item.status = "done";
        }
      } else if (!existing || existing.item.status === "done" || (reset && existing.item.status === "cancelled")) {
        const worker = await tx.createTask(tasks.get(kind)!, id, { ownership: { kind: "conversation" }, background: true });
        byId[id] = { worker, window, item: { id, kind, text, at: first, createdAt: now(), status: "scheduled" } };
      } else if (existing.item.status === "scheduled" && existing.window !== window && (reset || existing.window !== undefined)) {
        await tx.signal(existing.worker, Cancel, String(existing.item.at), true);
        existing.item.at = first;
      }
      if (existing) existing.window = window;
    }, context);
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

  const capability: Capability = { id: "schedule", mainLeasable: false, actions: scheduled.actions };
  return { register, migrate, ensureAdaptive, create: (input: Input) => create(input), list, cancel, capability, tools: scheduled.tools };
}
