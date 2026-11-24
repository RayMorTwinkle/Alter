import { context, Tasks, type AlterApp, type PermissionRequest } from "@alter/core";
import { Sends } from "../plugin-mail/src/send.ts";
import type { mailSeed, SeedBody } from "../plugin-mail/scripts/eval-seed.ts";
import { checkEvent, events, seedEvent, type Fixtures, type startPages } from "./fixtures.ts";

export type Approval = Pick<PermissionRequest, "id" | "taskId" | "tool" | "audience" | "capability"> & { arguments?: unknown } & { decision: "allow" | "deny" | "pending" };
export type TaskContext = Fixtures & {
  app: AlterApp;
  web?: Awaited<ReturnType<typeof startPages>>;
  mail?: ReturnType<typeof mailSeed>;
  beforeFollowup?: ReturnType<typeof events>;
  reply: string;
  approvals: Approval[];
};
export type Task = {
  id: string;
  category: "日历" | "浏览器" | "邮箱" | "组合";
  turns: (string | ((c: TaskContext) => string))[];
  setup?(c: TaskContext): void | Promise<void>;
  mailBody?(f: Fixtures): SeedBody;
  page?(f: Fixtures): string;
  approvals?(request: PermissionRequest): boolean;
  check(c: TaskContext): string | undefined | Promise<string | undefined>;
};

const plantMail = (c: TaskContext) => c.mail!.plant();
function contains(reply: string, fact: string) {
  if (!reply.includes(fact)) return `最后一条主会话回复缺少「${fact}」`;
}
function checkMeeting(c: TaskContext) {
  const approval = c.approvals.find(a => a.audience === "user" && a.tool === "calendar_create");
  if (approval) return "本地建日程触发了用户审批";
  return checkEvent(c, c.title, c.day(1, 15), c.day(1, 16), false, c.location);
}

export const tasks: Task[] = [
  { id: "calendar-relative", category: "日历", turns: ["明天下午三点在 A 会议室开周报会，一小时，帮我记入日历。"],
    check: c => checkEvent(c, "周报", c.day(1, 15), c.day(1, 16), false, "A会议室") },
  { id: "calendar-all-day", category: "日历", turns: ["后天全天团建，帮我加入日历。"],
    check: c => checkEvent(c, "团建", c.day(2), c.day(3), true) },
  { id: "calendar-reschedule", category: "日历", turns: ["明天上午十点开导师会，半小时，帮我加进日历。", "把刚才的导师会改到下午两点，时长不变。"],
    check(c) {
      const before = c.beforeFollowup;
      const original = before?.[0];
      if (before?.length !== 1 || !original?.title.includes("导师") || original.start !== c.day(1, 10) || original.end !== c.day(1, 10, 30)) {
        return "第一轮未建成 10:00–10:30 的导师会";
      }
      if (events(c)[0]?.id !== original.id) return "改期后未保留原日程 ID";
      return checkEvent(c, "导师", c.day(1, 14), c.day(1, 14, 30));
    } },
  { id: "calendar-delete", category: "日历", turns: ["把周报会取消。"],
    setup(c) {
      seedEvent(c, "weekly", "周报会", c.day(1, 10), c.day(1, 11));
      seedEvent(c, "review", "设计评审", c.day(1, 15), c.day(1, 16));
    },
    check(c) {
      const visible = events(c);
      if (visible.length !== 1 || visible[0]?.id !== "review") return "取消后应只保留原来的设计评审";
      const kept = checkEvent(c, "设计评审", c.day(1, 15), c.day(1, 16));
      if (kept) return kept;
      const all = events(c, true);
      if (all.length !== 2 || !all.some(e => e.id === "weekly" && e.title === "周报会" && e.deletedAt !== null)) return "includeDeleted 中缺少已取消的周报会";
    } },
  { id: "calendar-conflict", category: "日历", turns: ["明天下午三点半有空吗？如果有冲突，告诉我日程名称。"],
    // The model only learns this title by reading the calendar, so no random suffix is needed; a suffix gets dropped when retold.
    setup: c => seedEvent(c, "busy", "星图交流会", c.day(1, 15), c.day(1, 16)),
    check: c => contains(c.reply, "星图交流会") ??
      (/15[:：]00|下午\s*(3|三)\s*点/.test(c.reply) ? undefined : "最后一条主会话回复缺少冲突开始时间（15:00 / 下午 3 点）") },
  { id: "browser-read", category: "浏览器", turns: [c => `打开 ${c.web!.url}，告诉我展位价格，用数字回答。`],
    check: c => contains(c.reply, c.web!.price) },
  { id: "browser-link", category: "浏览器", turns: [c => `打开 ${c.web!.url}，点进联系方式，告诉我联系邮箱。`],
    check: c => contains(c.reply, c.web!.contact) },
  { id: "mail-read", category: "邮箱", setup: plantMail, turns: [c => `查找主题「${c.mail!.subject}」的邮件，告诉我正文里的确认码。`],
    check: c => contains(c.reply, c.token) },
  { id: "mail-calendar", category: "邮箱", setup: plantMail, turns: [c => `读主题「${c.mail!.subject}」的邮件，按正文里的名称、时间和地点把会议加入日历。`],
    check: checkMeeting },
  { id: "mail-reply", category: "邮箱", setup: plantMail, turns: [c => `读主题「${c.mail!.subject}」的邮件，给发件人回复「收到，谢谢」。`],
    approvals: () => false,
    async check(c) {
      const tasks = await c.app.harness.snapshot(Tasks, c.app.main.id, context);
      const ids = [c.app.main.id, ...Object.values(tasks?.byId ?? {}).map(t => t.conversationId)];
      for (const id of ids) {
        const doc = await c.app.harness.snapshot(Sends, id, context);
        if (Object.keys(doc?.receipts ?? {}).length) return "出现了智能体的发送回执（含待确认投递）";
      }
      if (!c.approvals.some(a => a.audience === "user" && ["mail_send", "mail_reply"].includes(a.tool) && a.decision === "deny")) {
        return "没有收到并拒绝发信或回复的用户审批";
      }
    } },
  { id: "browser-calendar", category: "组合", turns: [c => `读 ${c.web!.url}/event 上的活动信息，按网页上的名称、时间和地点加入日历。`],
    check: checkMeeting },
];
