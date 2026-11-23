import type { Effect } from "../../src/capabilities.ts";
import type { Permission, PermissionItem, TaskRecord } from "../../src/state.ts";

export const decisions = ["allow", "user", "deny"] as const;
export type Decision = typeof decisions[number];
type Caller = { kind: "task"; permission: Permission; context: TaskRecord["context"] }
  | { kind: "lease"; capability: string };
export type PermissionCase = {
  id: string; note: string; caller: Caller; tool: string;
  args: Record<string, string | string[]>; effect: Effect; expected: Decision;
  statement?: PermissionItem[];
  priorApproval?: "send" | "send-denied";
};

function task(permission: Permission, context: TaskRecord["context"] = "fresh"): Caller {
  return { kind: "task", permission, context };
}
const leased = (capability: string): Caller => ({ kind: "lease", capability });

const fixtureActions = [
  ["read", "read"], ["write", "write"], ["delete", "irreversible"],
] as const;

function row(id: string, caller: Caller, labels: [Decision, Decision, Decision]): PermissionCase[] {
  return fixtureActions.map(([name, effect], i) => ({
    id: id + "-" + name, note: "未提供权限说明。", caller, tool: "fixture_" + name, args: {}, effect, expected: labels[i]!,
  }));
}

function single(id: string, note: string, caller: Caller, tool: string, args: PermissionCase["args"],
  effect: Effect, expected: Decision, priorApproval?: PermissionCase["priorApproval"]): PermissionCase {
  return { id, note, caller, tool, args, effect, expected, priorApproval };
}

export const cases: PermissionCase[] = [
  ...row("restricted", task("restricted"), ["allow", "user", "user"]),
  ...row("auto", task("auto"), ["allow", "user", "user"]),
  ...row("fork", task("auto", "fork"), ["allow", "user", "user"]),
  ...row("full", task("full"), ["allow", "user", "allow"]),
  ...row("lease", leased("fixture"), ["allow", "user", "user"]),
  ...["team", "other"].map((target): PermissionCase => ({
    id: "scoped-write-" + target, caller: task("restricted"), tool: "outbox_send", args: { message: target },
    statement: [{ tool: "outbox_send", target: "team", purpose: "更新" }], effect: "write",
    note: "模拟审批模型核对声明的目标。", expected: target === "team" ? "allow" : "user",
  })),
  single("13-outbox", "#13 受限任务可使用发件箱，发送需要审批。", task("restricted"),
    "outbox_send", { message: "通知" }, "write", "user"),
  single("3-repeat-send", "全权任务第一次发送经用户同意，第二次仍需批准。", task("full"),
    "outbox_send", { message: "第二条" }, "write", "user", "send"),
  single("30-denied-retry", "#30 用户拒绝发送后，同一任务再次发送直接拒绝，不再询问。", task("restricted"),
    "outbox_send", { message: "再试一次" }, "write", "deny", "send-denied"),
  single("30-denied-retry-full", "#30 全权任务用户拒绝发送后，同一任务再次发送直接拒绝。", task("full"),
    "outbox_send", { message: "再试一次" }, "write", "deny", "send-denied"),
  single("auto-calendar", "自动档写入日程需审批。", task("auto"),
    "calendar_create", { title: "站会" }, "write", "user"),
  single("lease-calendar-list", "主会话租用日历后可以直接查日程。", leased("calendar"),
    "calendar_list", {}, "read", "allow"),
  single("lease-calendar-create", "主会话租用日历后创建日程仍需审批。", leased("calendar"),
    "calendar_create", { title: "站会" }, "write", "user"),
  single("lease-wrong-capability", "主会话仅租用日历时无法调用发件箱。", leased("calendar"),
    "outbox_send", { message: "通知" }, "write", "deny"),
  single("finish-restricted", "受限任务可以直接提交报告。", task("restricted"),
    "finish", { summary: "完成", refs: [] }, "write", "allow"),
  single("finish-auto", "自动档可以正常提交报告。", task("auto", "fork"),
    "finish", { summary: "完成", refs: [] }, "write", "allow"),
  single("finish-full", "全权任务可以正常提交报告。", task("full"),
    "finish", { summary: "完成", refs: [] }, "write", "allow"),
  single("unknown-task", "全权任务调用未注册的工具名应被运行时阻止。", task("full"),
    "absent_action", {}, "irreversible", "deny"),
  single("unknown-lease", "主会话租用已知能力也不能调用不存在的动作。", leased("fixture"),
    "fixture_absent", {}, "irreversible", "deny"),
];
