import { calendarTime } from "./calendar-time.ts";
import type { createMemory } from "./memory.ts";
import { addNotification } from "./notifications.ts";
import { conversationDoc, ROOT_CONVERSATION_ID } from "./runtime.ts";
import type { createScheduler } from "./scheduler.ts";
import type { createDispatcher } from "./tasks.ts";
import { budgetExhausted, type ProactiveBudget } from "./usage.ts";

const Reviews = conversationDoc<{ last: Record<string, number> }>("goal-reviews", () => ({ last: {} }));
const cooldown = 3 * 86_400_000;

export function registerGoalReview(scheduler: ReturnType<typeof createScheduler>, memory: ReturnType<typeof createMemory>,
  dispatch: ReturnType<typeof createDispatcher>, budget: ProactiveBudget, timeZone: string, hasBrowser: boolean) {
  const time = calendarTime(timeZone);
  scheduler.register("goal-review", async (item, tx, at) => {
    const { last } = await tx.doc(Reviews, ROOT_CONVERSATION_ID);
    const day = time.midnight(at);
    for (const [id, reviewed] of Object.entries(last)) if (reviewed <= at - cooldown) delete last[id];
    const remaining = 2 - Object.values(last).filter(reviewed => reviewed >= day).length;
    if (remaining <= 0) return;
    const goals = memory.list().filter(g => g.kind === "goal" && g.status === "active" && !Object.hasOwn(last, g.id))
      .sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity)).slice(0, remaining);
    if (!goals.length) return;
    const funded = await budget.available(at);
    if (!funded || !hasBrowser) {
      await addNotification(tx, { id: `${item.id}-${item.at}`, at, kind: "goal", source: "goal", status: "unread",
        level: "silent", title: "已跳过目标复查", body: funded ? "浏览器能力未启用" : budgetExhausted }, day);
      return;
    }
    for (const goal of goals) {
      const deadline = goal.due === undefined ? "无期限" : `期限 ${time.describe(goal.due).iso}`;
      const brief = `围绕目标「${goal.text}」（${deadline}）做只读调研。找出 1～3 条用户可能不知道、对目标有帮助的新信息，每条附链接。不要发送任何内容。`;
      await dispatch(tx, ROOT_CONVERSATION_ID, `task-goal-${goal.id}-${at}`,
        { brief, context: "fresh", permission: "restricted", allow: ["browser"] }, { text: goal.text, timeZone });
      last[goal.id] = at;
    }
  });
}
