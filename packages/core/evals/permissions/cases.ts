import type { Effect } from "../../src/capabilities.ts";
import type { Permission, TaskRecord } from "../../src/state.ts";

export const decisions = ["allow", "main", "user", "deny"] as const;
export type Decision = typeof decisions[number];
type Caller = { kind: "task"; permission: Permission; allow: string[]; context: TaskRecord["context"] }
  | { kind: "lease"; capability: string };
// main-read means main reads before its own target or before dispatch (both fresh and fork inherit).
type Taint = "clean" | "task-read" | "main-read";
export type PermissionCase = {
  id: string; note: string; caller: Caller; taint: Taint; tool: string;
  args: Record<string, string | string[]>; effect: Effect; expected: Decision;
  priorApproval?: "capability" | "send";
};

function task(permission: Permission, allow: string[] = [], context: TaskRecord["context"] = "fresh"): Caller {
  return { kind: "task", permission, allow, context };
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

const listed = ["fixture"];
const reason = "执行任务";
export const cases: PermissionCase[] = [
  // Human labels in manifest order: read, write-local, external-send, irreversible, unknown.
  ...row("restricted-unlisted", "受限任务仅获准使用其他能力时", task("restricted", ["notes"]), "clean",
    ["main", "main", "user", "user", "user"]),
  ...row("restricted-listed", "受限任务使用清单内能力", task("restricted", listed), "clean",
    ["allow", "allow", "user", "user", "user"]),
  ...row("restricted-read", "受限任务读取不可信结果后用清单内能力", task("restricted", listed), "task-read",
    ["allow", "allow", "user", "user", "user"]),
  ...row("restricted-fork", "从已污染主会话分叉的受限任务用清单外能力", task("restricted", [], "fork"), "main-read",
    ["main", "main", "user", "user", "user"]),
  ...row("auto-unlisted", "自动档在允许清单为空时", task("auto"), "clean",
    ["allow", "allow", "user", "user", "user"]),
  ...row("auto-listed", "自动档从干净主会话分叉后用清单内能力", task("auto", listed, "fork"), "clean",
    ["allow", "allow", "user", "user", "user"]),
  ...row("auto-read", "自动档读取不可信结果后", task("auto"), "task-read",
    ["allow", "allow", "user", "user", "user"]),
  ...row("full-clean", "未污染的全权任务在清单为空时", task("full"), "clean",
    ["allow", "allow", "allow", "allow", "allow"]),
  ...row("full-read", "全权任务自行读取不可信结果后", task("full"), "task-read",
    ["allow", "allow", "user", "user", "user"]),
  ...row("full-fork", "全权任务从已污染的主会话分叉后", task("full", listed, "fork"), "main-read",
    ["allow", "allow", "user", "user", "user"]),
  ...row("full-fresh", "已污染主会话派出的全新全权任务", task("full", listed), "main-read",
    ["allow", "allow", "user", "user", "user"]),
  ...row("lease-clean", "干净的主会话通过有效租约", leased("fixture"), "clean",
    ["allow", "allow", "allow", "allow", "allow"]),
  ...row("lease-read", "主会话读取不可信结果后通过租约", leased("fixture"), "main-read",
    ["allow", "allow", "user", "user", "user"]),

  single("13-outbox", "#13 的允许清单同时包含日历和发件箱，发送仍需用户批准。", task("restricted", ["calendar", "outbox"]),
    "clean", "outbox_send", { message: "通知" }, "external-send", "user"),
  single("13-after-grant", "主会话实际批准发件箱能力后，发送仍需逐次询问用户。", task("restricted"),
    "clean", "outbox_send", { message: "通知" }, "external-send", "user", "capability"),
  single("3-repeat-send", "受污染全权任务第一次发送经用户同意，第二次仍需批准。", task("full"),
    "task-read", "outbox_send", { message: "第二条" }, "external-send", "user", "send"),
  single("auto-calendar", "自动档无日历授权也可创建本地日程。", task("auto"), "clean",
    "calendar_create", { title: "站会" }, "write-local", "allow"),
  single("lease-calendar-list", "主会话租用日历后可以直接查日程。", leased("calendar"), "clean",
    "calendar_list", {}, "read", "allow"),
  single("lease-calendar-create", "主会话租用日历后可以直接创建日程。", leased("calendar"), "clean",
    "calendar_create", { title: "站会" }, "write-local", "allow"),
  single("lease-calendar-taint", "主会话读取外部数据后仍可通过日历租约写本地日程。", leased("calendar"), "main-read",
    "calendar_create", { title: "站会" }, "write-local", "allow"),
  single("lease-wrong-capability", "主会话仅租用日历时无法调用发件箱。", leased("calendar"), "clean",
    "outbox_send", { message: "通知" }, "external-send", "deny"),
  single("request-read", "受限任务申请清单外的只读能力应询问主会话。", task("restricted"), "clean",
    "request_capability", { capability: "notes", reason }, "read", "main"),
  single("request-risky", "受限任务继承污点后申请发件箱能力仍由主会话判断。", task("restricted"), "main-read",
    "request_capability", { capability: "outbox", reason }, "external-send", "main"),
  single("request-listed", "受限任务重复申请清单内能力无需再次授权。", task("restricted", listed), "clean",
    "request_capability", { capability: "fixture", reason }, "unknown", "allow"),
  single("request-auto-local", "自动档申请仅含读取和本地写入的日历能力可以直接通过。", task("auto"), "clean",
    "request_capability", { capability: "calendar", reason }, "write-local", "allow"),
  single("request-auto-send", "按当前实现，自动档显式申请发件箱能力时按清单最高等级询问用户。", task("auto"), "clean",
    "request_capability", { capability: "outbox", reason }, "external-send", "user"),
  single("request-full-taint", "已污染全权任务申请高风险能力时尚未执行具体动作。", task("full"), "task-read",
    "request_capability", { capability: "fixture", reason }, "unknown", "allow"),
  single("request-missing", "即使是全权任务也不能申请未注册的能力。", task("full"), "clean",
    "request_capability", { capability: "absent", reason }, "unknown", "deny"),
  single("request-blank", "受限任务申请能力时理由仅有空白应被阻止。", task("restricted"), "clean",
    "request_capability", { capability: "notes", reason: " " }, "unknown", "deny"),
  single("finish-restricted", "允许清单为空的受限任务可以直接提交报告。", task("restricted"), "clean",
    "finish", { summary: "完成", refs: [] }, "write-local", "allow"),
  single("finish-auto", "自动档继承主会话污点后仍可正常提交报告。", task("auto", [], "fork"), "main-read",
    "finish", { summary: "完成", refs: [] }, "write-local", "allow"),
  single("finish-full", "全权任务自己读过不可信结果后仍可正常提交报告。", task("full"), "task-read",
    "finish", { summary: "完成", refs: [] }, "write-local", "allow"),
  single("unknown-task", "全权任务调用未注册的工具名应被运行时阻止。", task("full"), "clean",
    "absent_action", {}, "unknown", "deny"),
  single("unknown-lease", "主会话租用已知能力也不能调用不存在的动作。", leased("fixture"), "clean",
    "fixture_absent", {}, "unknown", "deny"),
];
