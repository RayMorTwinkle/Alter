import type { Effect } from "../../src/capabilities.ts";
import type { Permission, TaskRecord } from "../../src/state.ts";

export const decisions = ["allow", "user", "deny"] as const;
export type Decision = typeof decisions[number];
type Caller = { kind: "task"; permission: Permission; context: TaskRecord["context"] }
  | { kind: "lease"; capability: string };
// main-read means main reads before its own target or before dispatch (both fresh and fork inherit).
type Taint = "clean" | "task-read" | "main-read";
export type PermissionCase = {
  id: string; note: string; caller: Caller; taint: Taint; tool: string;
  args: Record<string, string | string[]>; effect: Effect; expected: Decision;
  priorApproval?: "send" | "send-denied";
};

function task(permission: Permission, context: TaskRecord["context"] = "fresh"): Caller {
  return { kind: "task", permission, context };
}
const leased = (capability: string): Caller => ({ kind: "lease", capability });

const fixtureActions = [
  ["read", "read", "读取可信数据"], ["write", "write-local", "写入本地数据"],
  ["send", "external-send", "向外发送"], ["delete", "irreversible", "执行不可逆删除"],
  ["run", "unknown", "执行已注册但副作用未知的动作"],
] as const;

type Labels = [Decision, Decision, Decision, Decision, Decision];
function row(id: string, note: string, caller: Caller, taint: Taint, labels: Labels): PermissionCase[] {
  return fixtureActions.map(([name, effect, action], i) => ({
    id: id + "-" + name, note: note + action + "。", caller, taint,
    tool: "fixture_" + name, args: {}, effect, expected: labels[i]!,
  }));
}

function single(id: string, note: string, caller: Caller, taint: Taint, tool: string, args: PermissionCase["args"],
  effect: Effect, expected: Decision, priorApproval?: PermissionCase["priorApproval"]): PermissionCase {
  return { id, note, caller, taint, tool, args, effect, expected, ...(priorApproval && { priorApproval }) };
}

export const cases: PermissionCase[] = [
  // Human labels in manifest order: read, write-local, external-send, irreversible, unknown.
  ...row("restricted-clean", "受限任务在干净会话中", task("restricted"), "clean",
    ["allow", "allow", "user", "user", "user"]),
  ...row("restricted-read", "受限任务读取不可信结果后用插件能力", task("restricted"), "task-read",
    ["allow", "allow", "user", "user", "user"]),
  ...row("restricted-fork", "从已污染主会话分叉的受限任务用插件能力", task("restricted", "fork"), "main-read",
    ["allow", "allow", "user", "user", "user"]),
  ...row("auto-clean", "干净会话中的自动档任务", task("auto"), "clean",
    ["allow", "allow", "user", "user", "user"]),
  ...row("auto-fork", "自动档从干净主会话分叉后用插件能力", task("auto", "fork"), "clean",
    ["allow", "allow", "user", "user", "user"]),
  ...row("auto-read", "自动档读取不可信结果后", task("auto"), "task-read",
    ["allow", "allow", "user", "user", "user"]),
  ...row("full-clean", "未污染的全权任务", task("full"), "clean",
    ["allow", "allow", "allow", "allow", "allow"]),
  ...row("full-read", "全权任务自行读取不可信结果后", task("full"), "task-read",
    ["allow", "allow", "user", "user", "user"]),
  ...row("full-fork", "全权任务从已污染的主会话分叉后", task("full", "fork"), "main-read",
    ["allow", "allow", "user", "user", "user"]),
  ...row("full-fresh", "已污染主会话派出的全新全权任务", task("full"), "main-read",
    ["allow", "allow", "user", "user", "user"]),
  ...row("lease-clean", "干净的主会话通过有效租约", leased("fixture"), "clean",
    ["allow", "allow", "allow", "allow", "allow"]),
  ...row("lease-read", "主会话读取不可信结果后通过租约", leased("fixture"), "main-read",
    ["allow", "user", "user", "user", "user"]),

  single("13-outbox", "#13 受限任务可使用发件箱，发送需要审批。", task("restricted"),
    "clean", "outbox_send", { message: "通知" }, "external-send", "user"),
  single("3-repeat-send", "受污染全权任务第一次发送经用户同意，第二次仍需批准。", task("full"),
    "task-read", "outbox_send", { message: "第二条" }, "external-send", "user", "send"),
  single("30-denied-retry", "#30 用户拒绝发送后，同一任务再次发送直接拒绝，不再询问。", task("restricted"),
    "clean", "outbox_send", { message: "再试一次" }, "external-send", "deny", "send-denied"),
  single("30-denied-retry-full", "#30 全权任务读过外部内容、用户拒绝发送后，同一任务再次发送直接拒绝。", task("full"),
    "task-read", "outbox_send", { message: "再试一次" }, "external-send", "deny", "send-denied"),
  single("auto-calendar", "自动档无日历授权也可创建本地日程。", task("auto"), "clean",
    "calendar_create", { title: "站会" }, "write-local", "allow"),
  single("lease-calendar-list", "主会话租用日历后可以直接查日程。", leased("calendar"), "clean",
    "calendar_list", {}, "read", "allow"),
  single("lease-calendar-create", "主会话租用日历后可以直接创建日程。", leased("calendar"), "clean",
    "calendar_create", { title: "站会" }, "write-local", "allow"),
  single("lease-calendar-taint", "主会话读取外部数据后须审批才可通过日历租约写本地日程。", leased("calendar"), "main-read",
    "calendar_create", { title: "站会" }, "write-local", "user"),
  single("lease-wrong-capability", "主会话仅租用日历时无法调用发件箱。", leased("calendar"), "clean",
    "outbox_send", { message: "通知" }, "external-send", "deny"),
  single("finish-restricted", "受限任务可以直接提交报告。", task("restricted"), "clean",
    "finish", { summary: "完成", refs: [] }, "write-local", "allow"),
  single("finish-auto", "自动档继承主会话污点后仍可正常提交报告。", task("auto", "fork"), "main-read",
    "finish", { summary: "完成", refs: [] }, "write-local", "allow"),
  single("finish-full", "全权任务自己读过不可信结果后仍可正常提交报告。", task("full"), "task-read",
    "finish", { summary: "完成", refs: [] }, "write-local", "allow"),
  single("unknown-task", "全权任务调用未注册的工具名应被运行时阻止。", task("full"), "clean",
    "absent_action", {}, "unknown", "deny"),
  single("unknown-lease", "主会话租用已知能力也不能调用不存在的动作。", leased("fixture"), "clean",
    "fixture_absent", {}, "unknown", "deny"),
];
