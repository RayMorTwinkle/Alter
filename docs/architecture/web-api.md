# Web API 契约（v1.30）

Web 前端（`packages/web`）与服务端（`packages/server`）之间的接口。HTTP 服务使用 `node:http`，网页推送用 SSE，节点连接使用 WebSocket（`ws`）。

## 运行

| 变量 | 默认 | 说明 |
|---|---|---|
| `ALTER_HEARTBEAT` | `on` | `off` 关闭巡检 |
| `ALTER_HEARTBEAT_HOURS` | `08:00-23:00` | 本地巡检时间窗，含起点，支持跨午夜 |
| `ALTER_TZ` | `Asia/Shanghai` | 提醒与每日重复使用的用户时区 |
| `ALTER_WEB_HOST` | `127.0.0.1` | 只监听本机；需要局域网访问时显式改 |
| `ALTER_WEB_PORT` | `4317` | |
| `ALTER_APPROVAL_TIMEOUT_MINUTES` | `1440` | 最终到期时间，修改只影响新请求 |
| `ALTER_APPROVAL_DEFAULT_MS` | `60000` | 任务审批的默认等待时间（毫秒） |
| `ALTER_APPROVAL_MODEL` | `on` | 首次启动使用的审批模式，已保存的 settings.json 优先 |
| `ALTER_USER_ID` | `admin` | 实例所属用户，也是节点 token 的路由前缀 |
| `ALTER_WEB_PASSWORD` | 无（必填） | 单用户登录密码 |
| `ALTER_FEISHU_APP_ID` / `ALTER_FEISHU_APP_SECRET` | 无 | 飞书凭证的环境变量后备值 |
| `ALTER_FEISHU_REDIRECT_URI` | 当前 Web 访问地址下的 `/api/feishu/oauth/callback` | 与开放平台登记值完全一致 |
| `ALTER_FEISHU_DOMAIN` | `feishu` | 国际版用 `lark` |

服务端同时托管前端构建产物（`packages/web/dist`），开发时前端用 Vite 代理 `/api`。

飞书自建应用需启用机器人，并在开放平台为事件和回调选择长连接。订阅消息事件 `im.message.receive_v1` 和卡片回调 `card.action.trigger`。在机器人私聊中发送配对码即可绑定。

### 飞书用户账号

在开放平台自建应用的「安全设置 → 重定向 URL」登记 `http://127.0.0.1:4317/api/feishu/oauth/callback`。浏览器必须能访问此地址。改用其他端口、域名或反向代理时，登记引导接口给出的地址。代理终止 TLS 时，请显式配置公网 HTTPS 回调地址。

在「权限管理」为用户身份开通以下权限并发布版本。授权页按空格分隔请求这六个 scope。

| Scope | 用途 |
|---|---|
| `offline_access` | 获取可续期的用户令牌 |
| `im:chat:read` | 列出用户所在会话 |
| `im:message` | 用户身份读写消息的基础权限 |
| `im:message.p2p_msg:get_as_user` | 读取单聊历史消息 |
| `im:message.group_msg:get_as_user` | 读取群聊历史消息 |
| `im:message.send_as_user` | 以授权用户身份发消息 |

网页通过顶层导航访问授权起点。服务使用授权码和 PKCE（S256）换取令牌，按用户身份调用飞书 API。令牌在数据目录的 `feishu-user.json` 中以 0600 权限原子保存。服务运行时提前刷新，重启后也会检查到期时间。刷新失败后需要重新连接。

机器人配对与账号授权独立。断开账号会删除本地令牌并作废未完成的授权请求，机器人仍可使用。

平台接口见[获取授权码](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code)、[列出群聊和单聊](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-chat-list.md)、[读取会话历史](https://open.feishu.cn/document/server-docs/im-v1/message/list)和[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)。

## 鉴权

- `POST /api/login` `{ password }` → `204`，设置 `HttpOnly; SameSite=Strict` 的会话 Cookie；失败 `401`
- `POST /api/logout` → `204`
- 飞书 OAuth 的 `GET /api/feishu/oauth/callback` 通过 10 分钟内单次有效的 state 验证跨站回调。其余受保护的 API 未登录返回 `401`
- 所有写请求要求 `Content-Type: application/json`（挡掉跨站表单提交）

## 多用户网关（v1.29）

- 注册调用 `POST /gateway/register { username, password, invite }`，成功返回 `201`。随后调用 `POST /gateway/login { username, password }` 获得网关 Cookie。`GET /gateway/me`、登录与注册均返回 `{ id, username, role }`。`POST /gateway/logout` 返回 `204`。
- 管理员通过 `GET /gateway/admin/users` 查看账号与实例状态、实际端口、RSS 和上次登录时间。`PATCH /gateway/admin/users/:id` 接受 `disabled?`、`role?`、`password?`。`POST /gateway/admin/users/:id/restart` 重启受管实例。
- `GET /gateway/admin/invites` 列出邀请码，`POST /gateway/admin/invites { days? }` 创建单次使用的邀请码，`DELETE /gateway/admin/invites/:code` 撤销邀请码。
- 受管实例的 `GET /api/service` 额外返回 `restrictedCapabilities`。前端可据此隐藏 `browser`、`adapters`、`ext-plugins`、`cli`、`feishu` 和 `service` 的专属设置。受限接口返回 `403`。
- 网页端请求函数见 `packages/web/src/api.ts` 导出的 `gatewayApi`。完整返回类型、状态码、节点升级路由和部署示例见[网关契约](gateway.md)。

## 数据类型

```ts
type TimelineItem = {
  id: string;                 // 稳定 ID（条目 ID 或提交 ID），前端据此去重
  kind: "user" | "assistant" | "thinking" | "tool" | "message" | "report" | "permission" | "notice";
  text: string;
  at: number;                 // 毫秒时间戳
  tool?: string;              // tool：调用的工具名
  args?: string;              // tool：参数的 JSON 文本，最多 600 个字符，截断后可能不是完整 JSON
  isError?: boolean;          // tool：结果返回后写入
  silent?: true;              // assistant：本回合已静默
  reason?: string;            // stay_silent 提供的原因
  runner?: NodeRunner;
  status?: "queued";          // 离线派发的工具结果
  taskId?: string;            // report / permission 关联的任务，或 dispatch_task 成功返回的任务 ID
  source?: string;            // v1.4：user 项带来源；web / feishu，旧记录返回 web
  model?: string;             // assistant / thinking / message：产生该条目的模型
};

type NodeRunner = { node: string; harness: "claude-code" | "codex" | "opencode" }; // node 为配对记录 ID

type Task = {
  taskId: string;
  brief: string;
  context: "fork" | "fresh";
  heartbeatAt?: number; heartbeatId?: string;
  originSilent?: true;        // 主会话在静默回合派出的任务
  continuedFrom?: string;
  triggerSource?: "scheduled";   // v1.13：定时派单
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  permission: "restricted" | "auto" | "full";
  allow: string[];            // 兼容旧客户端，恒为空数组
  status: "queued" | "running" | "completed" | "failed" | "interrupted";
  runner?: NodeRunner; cwd?: string; nativeSessionId?: string;
  reportSource?: "finish" | "last_message" | "failure";
  failure?: string;           // 取消任务在此接口返回 status="failed"、failure="cancelled"
  conversationId: string;
  createdAt: number;
  pending: PermissionRequest[];
};

type PermissionRequest = {
  id: string;
  taskId: string;
  // 主会话自己的租约审批使用 taskId = "main"，只出现在顶层 pending
  audience: "user";
  capability: string;
  tool: string;
  arguments: unknown;         // 解析后的参数
  reason: string;
  statement?: { tool: string; target: string; purpose: string; isNew: boolean }[];
  defaultAt?: number;         // 任务的默认决定时间
  deferred?: true;            // 调用已返回“暂未获批”，卡片仍可处理
  expiresAt: number;          // v1.1 新增，截止时间（Unix 毫秒）
};

type FeishuPairing = ({ paired: true } | { paired: false; code: string; expiresAt: number }) // Unix 毫秒
  & { account: { connected: boolean; name?: string } };

// v1.3 新增，仅在加载了日历插件时提供
type AgendaEvent = { id: string; title: string; start: number; end: number; allDay: boolean; location?: string; notes?: string };
type Agenda = { timeZone: string; events: AgendaEvent[] }; // 今天起 7 个本地日内的日程，按开始时间排序；全天日程 end 不含

type Watch = {
  id: string; brief: string; where: { channel: "feishu" | "mail"; chatId?: string; contact?: string };
  createdAt: number; until: number; keywords: string[]; thinking: NonNullable<Task["thinking"]>;
  status: "running" | "completed" | "cancelled" | "failed"; wakes: number; pollError?: string;
};

type Notification = {
  id: string; at: number; kind: "reminder" | "event" | "digest" | "goal" | "notify" | "message"; channel?: "web" | "cli" | "feishu"; level: "now" | "digest" | "silent";
  title: string; body?: string; source: string; ref?: string; filtered?: "duplicate" | "mute" | "marketing"; status: "unread" | "read";
  feedback?: "useful" | "useless"; pushedAt?: number; heartbeatAt?: number; heartbeatId?: string;
};

type Funnel = {
  timeZone: string;
  days: { date: string; triggered: number; passed: number; pushed: number; read: number;
    useful: number; useless: number; digests: number; reminders: number }[];
  precision: number | null;
};

type MemoryItem = {
  id: string;
  kind: "profile" | "goal" | "fact";
  text: string;
  due?: number;
  status: "active" | "done" | "pending";
  createdAt: number;
  updatedAt: number;
};

type ScheduleTrigger =
  | { kind: "at"; at: string }
  | { kind: "every"; minutes: number }
  | { kind: "daily"; time: string; weekdays?: number[] }
  | { kind: "event"; eventId: string; offsetMinutes: number; anchor: "start" | "end" };

type ScheduledTask = {
  id: string; brief: string; trigger: ScheduleTrigger; action: "task" | "wake";
  continue_from?: string; thinking?: "low" | "medium" | "high" | "max";
  createdAt: number; nextAt: number | null; paused: boolean;
  lastRun?: { dueAt: number; at: number; missed: boolean; skipped?: string; taskId?: string };
};

type LedgerEntry = { taskId: string; summary: string; refs: { kind: string; ref: string }[]; at: number };

type TranscriptItem =
  | { kind: "user" | "assistant" | "thinking" | "status"; text: string; at: number }
  | { kind: "tool_call"; tool: string; arguments: unknown; at: number }
  | { kind: "tool_result"; tool: string; text: string; isError: boolean; at: number };
```

## 接口

| 方法 | 路径 | 返回 |
|---|---|---|
| `GET` | `/api/watches` | `Watch[]`（v1.14） |
| `DELETE` | `/api/watches/:id` | 取消盯梢（v1.14） |
| `GET` | `/api/state` | `{ timeline: TimelineItem[], tasks: Task[], pending: PermissionRequest[], ledger: LedgerEntry[], schedules: ScheduledTask[], notifications: Notification[], watches: Watch[], leases: { capability: string; idleTurns: number; window: number }[], busy: boolean }` |
| `POST` | `/api/messages` | 请求 `{ text }` → `202 { id }`；主会话忙时排队，不报错 |
| `POST` | `/api/permissions/:id` | 请求 `{ decision: "once" &#124; "task-full" &#124; "deny", note?: string }` → `204`。已处理、已到期或对主会话租约选择任务级授权返回 `409`。旧客户端可用布尔字段 `allow` 提交单次批准或拒绝 |
| `GET` | `/api/tasks/:taskId/transcript` | `{ items: TranscriptItem[] }` |
| `POST` | `/api/stop` | 停止主会话当前回合 → `204` |
| `GET` | `/api/funnel?days=7` | `Funnel`（v1.8）。需要登录，默认 7 个本地日，支持 1–366 天。非法或重复的 `days` 返回 `400` |
| `GET` / `PATCH` | `/api/settings` | `Settings`，可分别修改审批模式、巡检与上下文压缩阈值，见 v1.15 |
| `GET` / `PUT` | `/api/service` | 读取或修改 macOS 后台服务设置，见下文 |
| `GET` | `/api/approvals/stats` | `{ modelAllowed, askedUser, userApproved, userDenied }`。依次为模型直接放行、转问用户、用户批准和用户拒绝的次数 |
| `GET` | `/api/stats?range=7d` | `Stats`（v1.11）。需要登录，默认 `7d`。支持 `day`、`7d`、`30d`、`all`；非法、空值或重复参数返回 `400` |
| `GET` | `/api/heartbeat` | 返回巡检开关、下次时间、自适应间隔、采纳率、当前需求信号及最近 50 条巡检记录，见下文 |
| `POST` | `/api/heartbeat/run` | 立即尝试巡检。已启动返回 202 与巡检记录，跳过或时间窗外返回 200 与原因。主会话忙返回 409 及 `{ error, id }` |
| `POST` | `/api/heartbeat/:id/feedback` | 请求体 `{ feedback: "useful" 或 "useless" }`。成功 204，非法反馈 400，未知 ID 404，未运行的记录 409 |
| `GET` | `/api/heartbeat/stats` | `{ lastInspection?: number, adoptionRate: number, history: { at: number, intervalMs: number }[] }`。时间和间隔以毫秒计，保留最近 50 次间隔计算 |
| `GET` | `/api/usage` | `usageSummary()` 的结果数组 |
| `GET` | `/api/feishu` | `FeishuPairing`（v1.6 含账号连接状态与可选显示名）；未登录 `401`，已登录但未配置飞书 `404`。未配对时返回当前 6 位码，10 分钟到期后轮换 |
| `GET` | `/api/feishu/oauth/start` | 需要登录；`302` 跳转至飞书授权页 |
| `GET` | `/api/feishu/oauth/callback?code=…&state=…` | 成功 `302` 回到 `/`；无效、过期、重复或拒绝授权返回 `400` 错误页；换令牌或保存失败返回 `502` 错误页 |
| `POST` | `/api/feishu/account/disconnect` | 需要登录；清除本地授权，重复调用均返回 `204` |
| `GET` | `/api/schedules` | `ScheduledTask[]`（v1.13），含已暂停和已完成的定时任务 |
| `PATCH` | `/api/schedules/:id` | 请求 `{ paused: boolean }` → `204`，重复设置相同状态也返回 `204`。参数错误返回 `400`，未知或已完成返回 `404` |
| `DELETE` | `/api/schedules/:id` | 删除后返回 `204`，未知或已删除返回 `404` |
| `GET` | `/api/calendar` | `Agenda`（v1.3）；未加载日历插件时 `404` |
| `POST` | `/api/notifications/:id` | 更新已读或反馈 → `204`。请求至少含 `status`（仅 `read`）或 `feedback`（`useful` 或 `useless`）之一。无效字段返回 `400`，未知或已淘汰的 ID 返回 `404` |
| `GET` | `/api/memory` | `MemoryView`，包含字符串索引 `index`、当前条目 `entries`（更新时间倒序）和 `needsConsolidation` |
| `GET` | `/api/memory/:id` | `MemoryEntry`，含已取代的历史条目。找不到返回 `404` |
| `PATCH` | `/api/memory/:id` | 编辑当前条目的 title、type、body、source、guess、dueAt 或 status，至少一项。确认推测传 `{"guess":false}`。目标期限为 Unix 毫秒，传 null 清除。成功 204，非法 400，缺失或已取代 404 |
| `DELETE` | `/api/memory/:id` | 删除当前条目 → 204，缺失或已取代 404 |
| `GET` | `/api/memory/changes` | `MemoryChange[]`，最新在前，含操作、受影响 ID 和逐条前后快照 |
| `POST` | `/api/memory/changes/:id/undo` | 原子恢复该次变更的快照 → 204。变更缺失 404，已撤销、撤销记录本身或所涉条目有后续冲突时 409 |
| `GET` | `/api/events` | SSE，见下 |

`read` 和内部控制动作直接放行。审批模型默认开启（`on`），对每次 `write` 核对权限说明和调用参数。任务使用 `declare_permissions` 的当前说明。主会话使用最近三条用户输入的原文，每条最多 1000 字符，任一条超长时交用户确认。模型关闭（`off`）、缺少说明或超出范围时询问用户。不可逆和未知效果直接问用户，全权限任务可直接执行。

`once` 批准当前调用，`task-full` 批准当前任务的后续调用（包括不可逆操作），`deny` 拒绝当前调用并阻止任务重试该工具。主会话支持 `once` 和 `deny`。等待一分钟后调用返回“暂未获批”，审批卡片保留至 24 小时到期。用户补批后，相同工具和参数可执行一次。

漏斗按通知的 `at` 归到用户本地日期，从早到晚列出截至今天的每一天，空日补零。统计基于当前保留的最近 500 条通知，淘汰的记录无法计入。事件计入 `triggered`，通过预过滤的事件计入 `passed`。配置飞书时，`pushed` 只计已有 `pushedAt` 的 `now` 事件；未配置时计所有 `now` 事件。已读和两种反馈独立统计事件的当前状态。摘要和提醒仅计入 `digests`、`reminders`。窗口内的打扰精准率为有用数除以有反馈的事件数，无反馈返回 `null`。

v1.7 的通知列表按写入顺序从新到旧保留 500 条。`at` 为实际投递到通知中心的 Unix 毫秒时间。按用户本地时间，23:00（含）至次日 08:00（不含）触发的提醒记为 `digest`，其余记为 `now`。已配对的飞书私聊推送新的未读 `now` 通知。读状态和反馈可独立更新，重复提交同一值仍返回 `204`。

记忆接口使用登录会话。v1.19 保留旧 PATCH 字段 text、due 和 status。旧列表可以用 `?memory=legacy` 读取。现有浏览器页面发出的 `Sec-Fetch-Dest: empty`、`Accept: */*` 请求也使用旧列表。新客户端可显式请求 `?memory=entries`。读取时已过期的 active 目标转为 pending。条目 ID 为字符串，时间戳为 Unix 毫秒。后台整理允许通过 `ALTER_MEMORY_CONSOLIDATION_TURNS` 选择 200–300 轮，默认 250 轮，用户空闲满 30 分钟触发。

`timeline` 返回最近 200 条；更早的用 `GET /api/state?before=<id>` 分页（v1 可不实现）。

## macOS 后台服务（#110）

- `GET /api/service` 返回 `{ supported, autostart, keepAlive, preventSleep, managed }`，字段均为布尔值。`supported` 表示当前实例可管理 macOS 后台服务。`managed` 表示当前进程由 launchd 以 `top.raymor.alter` 标签启动。
- `PUT /api/service` 接受 `autostart`（用户登录时启动）、`keepAlive`（异常退出后重启）、`preventSleep`（阻止系统因空闲而睡眠）的任意子集。三个开关默认关闭，保存在数据目录的 `service.json` 中。省略的字段保留原值。未知字段、非布尔字段或非对象请求体返回 `400`，在非 macOS 平台提交有效设置返回 `409`。
- 成功写入返回 `200`，响应结构与 GET 相同。`managed` 描述发出响应的进程。需要切换时，服务在响应发出后重启，客户端重连后可再次 GET 确认。关闭登录启动和异常重启两个开关会移除 LaunchAgent，切回普通进程。单独修改 `preventSleep` 会即时启停 `caffeinate`，无需重连。

## 定时任务（v1.13）

主会话通过 `schedule_task` 创建，网页可查看、暂停、恢复和删除。时间戳均为 Unix 毫秒。`at` 接受 ISO 时间，无偏移量时使用用户时区。`every` 按创建时刻对齐，间隔至少 5 分钟。`daily` 使用本地 `HH:mm`，可附非空的星期数组（0 为周日）。`event` 以当前日程的开始或结束时间加有符号的分钟数计算，日程改期后更新，删除日程会移除关联安排并在时间线留下通知。

`nextAt` 为当前计划时间，已完成的一次性安排为 `null`。暂停期间停止执行。恢复周期任务时跳到下一个计划时刻，恢复已到点的一次性任务会执行一次。离线期间错过多次只补跑一次。`lastRun.dueAt` 是本次处理的原定时间，`at` 是实际处理时间。重启时已过期或运行中晚到至少一分钟记 `missed: true`。当日主动预算耗尽或接续目标仍在运行时，`skipped` 给出本次跳过原因。

新任务默认使用 `fresh` 上下文和 `restricted` 权限。`continue_from` 用于 `task`，继承原任务的会话、权限和约束。`wake` 将简报作为主会话自己的安排写入时间线，来源为 `schedule`。`/api/stats` 的定时调用计入 `byRole` 的 `schedule`，定时派单的任务明细含 `triggerSource: "scheduled"`。

## 调用、任务与唤醒统计（v1.11）

完整 TypeScript 返回类型见 [Stats](../../packages/web/src/types.ts)。`at` 是服务端采样时的 Unix 毫秒时间。窗口按用户配置时区的本地日期计算，包含今天，截至 `at`。`daily` 由早到晚补齐空日。`all` 从最早有记录的本地日期开始，空库返回今天一行。

| 字段 | 统计口径 |
|---|---|
| `total`、`byRole[]`、`byModel[]`、`daily[].usage` | 按调用开始时间累加模型尝试。角色为可扩展字符串，如 `main`、`task`、`triage`、`goal`、`judge`、`watch`、`schedule`、`heartbeat` |
| `tasks` | 按创建时间筛选任务，明细含截至采样时的用量、模型、思考强度、轮数、工具名与次数、耗时、审计条目、结果摘要、`continuedFrom` 和发起派单的 `wakeId`。成功率为完成数除以已结束数，失败和取消均计入分母，分母为零返回 `null` |
| `silent` | 所选时间范围内显式调用 `stay_silent` 的主会话回合数，按唤醒时间归档，每轮计一次。 |
| `wakes` | 按实际开始的主会话回合筛选。来源示例为 `user-web`、`user-feishu`、`user-cli`、`report`、`approval`、`schedule`、`watch`。同一次唤醒内的工具循环和回退共用 ID。多条输入同时启动一个回合时取第一条来源。用量只合计该主会话回合；派单数由任务创建记录关联。单纯投递通知不产生唤醒 |
| `approvals` | `decisions` 按窗口内的 Audit 时间分别计数，`park` 表示曾等待审批，`allow` 和 `deny` 包含自动策略决定。`pending` 为采样时待处理的请求。三种用户决定、模型放行、转问用户和最终过期分别计数，详见下文 |
| `latency` | `firstToken` 与 `total` 各返回 `samples / p50Ms / p95Ms`。用毫秒最近秩计算，只纳入相应延迟已上报的尝试，无样本时分位数为 `null` |
| `funnel`、`watchWakeAccuracy` | 漏斗复用 `/api/funnel` 的通知保留与投递规则。准确率为所选时段内调用 finish 的盯梢批次 / 唤醒批次，含到期收尾。无唤醒时为 `null` |
| `topTasks`、`daily` | 费用可确定的任务按美元降序取前十，金额相同按任务 ID 排序。日序列还给出当日创建的任务数、其中已完成数、当日唤醒数 |

**审批统计。** `userDecisions` 按 `once / task-full / deny` 统计，历史的按说明批准计入单次批准。`judgments` 按 `inScope / outOfScope` 统计模型判断。`modelAllowed / askedUser / userApproved / userDenied` 与审批统计接口口径一致，各事件按自己的时间归入窗口。无时间戳的旧用户决定仅计入 `all`。

`byApprover` 的 `user` 计用户实际决定，`judge` 计模型直接放行，`timeout` 和 `timeouts` 统计软超时。软超时后用户补批会再产生一次用户决定；最终过期单独计入 `expired`。旧记录无法区分软超时与直接放行的部分不追溯归类。任务的 `reviews` 按请求 ID 关联用户选择、模型结论、暂缓或过期及时间；任务用量含关联的 judge 调用，任务工具和轮数只计执行任务的模型。

每个用量对象含 `calls / input / cacheRead / cacheWrite / output / tokens / cacheHitRate / costUsd / errors / aborted / fallbacks / retries`。`tokens` 是四类 token 之和，命中率用累计的 `cacheRead / (input + cacheRead + cacheWrite)`。只汇总已报告 token。旧行的合并输入计入 `input`；分组包含无法拆分的正输入或分母为零时，命中率为 `null`。主动中止计入 `aborted`，供应商失败计入 `errors`。切换模型的后续尝试计入 `fallbacks`，显式重试同一模型计入 `retries`。网关关闭了 SDK 内部自动重试。

费用在写入时用数据目录下可选的 `prices.json` 估算。文件格式为 `Record<模型 ID, { input: number, cacheRead: number, cacheWrite: number, output: number }>`，单位为美元／百万 token。默认价格表为空。缺少价格、缺少用量或分组内任一尝试无法估价时，`costUsd` 为 `null`。修改价格影响后续调用，历史估价保留。

任务 `rounds` 按逻辑模型调用计数，同轮的备用尝试单独计入 `usage.calls`。工具计数按模型发出的工具调用计，包括被拒绝的调用。任务无可关联用量行时，按该任务简报到结束条目之间的持久化对话恢复模型、轮数、工具和已报告 token，标为 `usageSource: "transcript"`。对话只保留终态回答，无法还原中间回退；这些恢复值仅用于任务明细。缺少历史唤醒 ID 的调用仅计入调用汇总。

<details>
<summary>离线网关的一次 Web 唤醒：GET /api/stats?range=day 完整响应</summary>

```json
{
  "range": "day",
  "silent": 1,
  "timeZone": "Asia/Taipei",
  "at": 1795399200000,
  "total": {"calls": 1, "input": 6, "output": 3, "cacheRead": 2, "cacheWrite": 0, "tokens": 11, "costUsd": null, "cacheHitRate": 0.25, "errors": 0, "aborted": 0, "fallbacks": 0, "retries": 0},
  "byRole": [{"role": "main", "calls": 1, "input": 6, "output": 3, "cacheRead": 2, "cacheWrite": 0, "tokens": 11, "costUsd": null, "cacheHitRate": 0.25, "errors": 0, "aborted": 0, "fallbacks": 0, "retries": 0}],
  "byModel": [{"model": "offline/main", "calls": 1, "input": 6, "output": 3, "cacheRead": 2, "cacheWrite": 0, "tokens": 11, "costUsd": null, "cacheHitRate": 0.25, "errors": 0, "aborted": 0, "fallbacks": 0, "retries": 0}],
  "tasks": {"count": 0, "completed": 0, "terminal": 0, "successRate": null, "items": []},
  "wakes": {"count": 1, "bySource": {"user-web": 1}, "items": [{"wakeId": "wake-19", "wakeSource": "user-web", "wakeAt": 1795399200000, "usage": {"calls": 1, "input": 6, "output": 3, "cacheRead": 2, "cacheWrite": 0, "tokens": 11, "costUsd": null, "cacheHitRate": 0.25, "errors": 0, "aborted": 0, "fallbacks": 0, "retries": 0}, "dispatchedTasks": 0}]},
  "approvals": {"decisions": {"park": 0, "allow": 0, "deny": 0}, "pending": [], "userDecisions": {"once": 0, "task-full": 0, "deny": 0}, "judgments": {"inScope": 0, "outOfScope": 0}, "byApprover": [{"approver": "user", "count": 0}, {"approver": "judge", "count": 0}, {"approver": "timeout", "count": 0}], "timeouts": 0, "expired": 0, "modelAllowed": 0, "askedUser": 0, "userApproved": 0, "userDenied": 0},
  "funnel": {"timeZone": "Asia/Taipei", "days": [{"date": "2026-11-23", "triggered": 0, "passed": 0, "pushed": 0, "read": 0, "useful": 0, "useless": 0, "digests": 0, "reminders": 0}], "precision": null},
  "watchWakeAccuracy": null,
  "latency": {"firstToken": {"samples": 1, "p50Ms": 115, "p95Ms": 115}, "total": {"samples": 1, "p50Ms": 118, "p95Ms": 118}},
  "topTasks": [],
  "daily": [{"date": "2026-11-23", "usage": {"calls": 1, "input": 6, "output": 3, "cacheRead": 2, "cacheWrite": 0, "tokens": 11, "costUsd": null, "cacheHitRate": 0.25, "errors": 0, "aborted": 0, "fallbacks": 0, "retries": 0}, "tasks": 0, "succeeded": 0, "wakes": 1}]
}
```

</details>

## SSE 事件（`/api/events`）

连接建立后先发一次 `snapshot`（内容同 `/api/state`），之后增量推送：

| event | data | 说明 |
|---|---|---|
| `watches` | `Watch[]` | 盯梢记录变化（v1.14） |
| `ext-plugins` | `ExtPluginView[]` | 首连、重连、审批、运行状态或版本变更时整体替换（v1.17） |
| `sources` | `SourceView[]` | 首次连接、重连、实例配置或轮询状态变化时整体替换（v1.16） |
| `snapshot` | 同 `/api/state` | 首次连接与重连时 |
| `timeline` | `TimelineItem` | 按 id 新增或更新条目，含用户消息回显与工具结果状态 |
| `delta` | `{ id: string; text: string }` | 主会话正在生成的回答，`text` 为**累计全文**，结束时由同 `id` 的 `timeline` 条目取代 |
| `tasks` | `Task[]` | 任务列表整体替换 |
| `pending` | `PermissionRequest[]` | 待审批列表整体替换 |
| `ledger` | `LedgerEntry[]` | 账本整体替换 |
| `busy` | `{ busy: boolean }` | 主会话是否在生成 |
| `schedules` | `ScheduledTask[]` | v1.13：创建、暂停、恢复、改期、触发或删除后整体替换。首次连接与重连由 snapshot 提供 |
| `notifications` | `Notification[]` | v1.7 新增。提醒触发、已读或反馈更新时整体替换，首次连接与重连由 snapshot 提供 |
| `heartbeat` | `{ type: "start" 或 "end", id }`、`{ type: "feedback", id, feedback }` 或 `{ type: "schedule", nextAt }` | 巡检开始、结束（含跳过或顺延）、反馈或下次时间变化。收到事件及重连后读取 `GET /api/heartbeat` |
| `memory` | `MemoryItem[]` 或 `MemoryView` | 工具、网页、整理、撤销或目标过期后推送全量列表。`/api/events?memory=entries` 的同名事件返回 `MemoryView`。连接或重连后 GET 同格式列表初始化 |
| `calendar` | `Agenda` | v1.3：日程变化时整体替换。不包含在 `snapshot` 中，重连后前端重新请求 `/api/calendar` |

每 20 秒发一次注释行 `: ping` 保活。前端断线后用 `EventSource` 自动重连，并以收到的 `snapshot` 为准重建状态。

## 错误

除飞书 OAuth 回调的 HTML 错误页外，API 错误响应体为 `{ error: string }`。

## 主会话巡检（v1.12）

从 v1.12 起，飞书发送成功或 Web SSE 投递的未读立即通知可随下一次唤醒进入模型上下文。同一通知跨渠道只附带一次，优先保留最近的 20 条，整个附带段最多 1500 字。明细只含通知 ID、来源和标题。

`GET /api/heartbeat` 返回 `{ enabled, nextAt, intervalMs, adoption, signals, runs }`。时间均为 Unix 毫秒。停用时 `nextAt` 为 `null`。`signals` 包含未来 7 天到期的活跃目标数 `dueGoals`、上次巡检以来的摘要通知数 `backlog`、过去 24 小时主会话用户消息数 `userMessages24h`。

初始间隔为 5 小时，按采纳率和三个需求信号调整，范围为 2–48 小时。默认只在本地 08:00（含）到 23:00（不含）开始，落在窗外的触发时间顺延至下一次开放。自动巡检遇忙每分钟重试，超过一小时跳过；最近半小时主会话活跃也跳过。六类线索均无变化且距上次实际巡检不足 24 小时才因内容未变跳过。首次巡检和满 24 小时的复查可以在线索为空时运行。

手动触发忽略近期活跃和内容未变，沿用开关、时间窗与每日主动预算，保留自动巡检的下次时间。遇忙返回 409，记录为 `skipped / busy`，由调用方决定是否重试。飞书和 Web 用户消息在巡检后的两小时内、由巡检派出的任务完成且未被拒绝、巡检或关联通知获得“有用”评价，均可形成采纳信号。每次实际巡检产生一个 EWMA 样本（初始 0.5，α 为 0.3）。修改反馈按原回合权重修正；显式“没用”优先。

`runs` 按最近发生的顺序返回，每次尝试均有独立 ID。

| 字段 | 含义 |
|---|---|
| `id, at, finishedAt` | 巡检 ID、开始时间、结束时间。正在运行时 `finishedAt` 为 `null` |
| `status, skipReason` | `ran / skipped / deferred`。运行时原因为 `null`，其他取值为 `disabled / outside-hours / busy / busy-timeout / recent-activity / unchanged / budget` |
| `counts` | 六类线索限长展示前的条数，字段为 `goals, memories, agenda, chat, tasks, digests`。聊天取最近八轮用户输入，记忆包含用户偏好和最近八条事实 |
| `actions` | 按执行顺序列出本轮主会话成功调用的工具，每项含 `tool`。派单、盯梢、通知、创建或取消调度附返回的 `id`。通知的 `level` 是安静时段处理后的实际级别 |
| `notified, finalReply` | 是否成功写入了面向用户的消息（立即投递），以及主会话本轮最后回复。网页时间线展示最终回复或静默草稿，巡检工具调用显示为简短提示 |
| `tokens, feedback` | 本轮主会话对话中模型报告的 token 总数（含缓存），以及对本轮的直接反馈 `useful / useless / null` |

主会话自行决定是否告知用户、派任务、开盯梢、另寻线索或什么都不做。主会话的最终正文写入立即通知。调用 `stay_silent` 后，本轮正文在网页上显示为静默草稿。巡检及其派单的请求按 `role: "heartbeat"` 计入每日主动预算，主会话的唤醒来源为 `heartbeat`。

## 盯梢（v1.14）

`GET /api/watches` 返回全部盯梢记录的数组。`GET /api/state` 和 SSE 首帧包含同一形状的 `watches` 字段。记录变化时 SSE 发送 `watches` 事件，数据为完整数组。

每条记录包含 `id`（也是 taskId）、`brief`、`where`、`keywords`、`thinking`、`createdAt` 和 `until`（Unix 毫秒）、`wakes`（任务唤醒批数）、`status`（running / completed / cancelled / failed）。上次拉取失败时附带 `pollError`，成功后清除。

`DELETE /api/watches/:id` 与 `task_cancel` 共用取消流程。请求使用 JSON Content-Type。取消和重复取消返回 204，未知 ID 返回 404，其他已结束的任务返回 409。

主会话以 `watch({ brief, where: { channel, chatId?, contact? }, until, keywords?, thinking? })` 创建。渠道为 feishu 或 mail。飞书联系人建议使用发送者 open_id，邮件使用发件地址。`until` 接受未来 ISO 时间（无偏移时按用户时区）或从现在起的分钟数。默认 low。观察时段含起点、不含终点。关键词忽略大小写，任意一个子串命中即可。

飞书长连接和收件箱新邮件可直接触发，用户身份飞书历史和 IMAP 收件箱每 60 秒补拉。创建时检查渠道授权。首次命中开启固定合并窗，`ALTER_WATCH_BATCH_MS` 默认为 30000。到期收尾包含尚未交付的批次。重启时已到期的记录直接收尾。主动预算用完时暂存待处理批次，到期仍无余额则失败并记账。统计按 `watch` 记录任务用量，每日主动预算计入实际 token 和每个唤醒批次一次。报告唤醒主会话时 `wakeSource` 为 `watch`。

## 设置与插件（v1.15）

以下接口沿用会话鉴权和 JSON 写入规则。字段类型见 `packages/web/src/types.ts`。

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/api/plugins` | `PluginView[]`，按 `id` 识别 |
| PATCH | `/api/plugins/:id` | 提交 `{ enabled?, settings? }`，等待该插件重新初始化后返回完整 `PluginView` |
| POST | `/api/plugins/:id/check` | 使用 JSON 请求头，重新检查并返回完整 `PluginView` |
| GET | `/api/plugins/feishu/guide` | `{ permissionsJson, redirectUri, eventsMode: "long-connection", steps }`，权限 JSON 字符串可直接粘贴至开放平台 |
| GET / PATCH | `/api/settings` | 返回 `{ approvalModel, heartbeat: { enabled, start, end }, compactAtTokens }`。PATCH 至少提交一个字段，heartbeat 支持部分修改 |

`compactAtTokens` 是正整数，默认 400,000 token。小窗口模型会按实际窗口预留回复空间。在 1,000,000 token 窗口下使用默认值时，估算上下文超过 395,904 token 可启动后台压缩，超过 400,000 token 时下一次生成等待压缩。盯梢任务关闭自动压缩。

插件视图含 `id, name, provides, settings, enabled, values, status`。三组 `provides.channels/capabilities/sources` 使用标识符数组。Web 为内置渠道。飞书、邮件、浏览器、日历、模板消息来源的标识符依次为 `feishu, mail, browser, calendar, sources`。每个表单字段含 `key, label, type, required, help`，select 附 `options`。提交示例：

```json
{"enabled":true,"settings":{"ALTER_FEISHU_APP_ID":"cli_example","ALTER_FEISHU_APP_SECRET":"example-only"}}
```

`values` 按字段 key 返回实际使用值。secret 只返回 `{"set":true}` 或 `{"set":false}`。App ID 等普通文本完整返回，未填且无默认值时为 `null`。PATCH 的 `null` 清除本地覆盖，回退到环境变量，再回退到字段默认值。保存的插件字段和开关逐值加密到数据目录的 `secrets.json`，与 32 字节的 `secret.key` 均为 0600。未知插件返回 404，未知字段、非法类型及空补丁返回 400。连接失败时配置仍保存，响应为 200，原因见 `status.detail`。

`status.state` 为 `off | needs-config | connecting | ok | error`，可带 `detail` 和 `checks: { id, label, ok, detail? }[]`。缺少必填项时进入 needs-config。配置就绪后飞书报告凭证、WebSocket、机器人配对和用户授权，邮件分别验证 IMAP 登录与 SMTP，浏览器检查 ego-browser。飞书引导优先使用配置的回调地址，否则从当前 HTTP(S) 请求的访问地址推导；OAuth 授权和换取令牌使用同一地址。

`plugins` SSE 事件携带与 GET 相同的完整数组，首次连接、重连或插件状态变化时发送。客户端整体替换。巡检保存后即时更新原有 `heartbeat` 视图和调度事件。时间使用服务配置的时区，格式为 `HH:MM`，支持跨午夜，起止必须不同；停用后 `nextAt` 为 null。审批模式支持 `on / off`，默认开启。

活跃盯梢保留原任务 ID 和拉取进度。邮件或飞书插件重新配置后，下次补拉使用当前插件实例。停用期间拉取失败会记录 `pollError`；在观察期内重新启用并授权后，从上次成功拉取的位置继续。

## 模板消息来源（v1.16）

所有接口沿用 Web 会话鉴权。写请求使用 JSON Content-Type。

| 方法 | 路径 | 请求与响应 |
|---|---|---|
| GET | `/api/sources/templates` | 返回 `SourceTemplate[]`。每个模板含 `template, name, fields`，字段使用 `PluginField` |
| GET | `/api/sources` | 返回 `SourceView[]`，包括已停用的实例 |
| POST | `/api/sources/preview` | 提交 `template, params`，返回 `200 { samples }`，最多三条。试拉期间不保存配置、进度或消息 |
| POST | `/api/sources` | 提交 `name, template, params, intervalMinutes?, enabled?`。试拉成功返回 `201 { source, samples }`，失败不创建实例 |
| PATCH | `/api/sources/:id` | 可修改名称、启用状态、间隔及部分参数。返回更新后的 `SourceView`。模板类型固定 |
| DELETE | `/api/sources/:id` | 删除实例、凭证和轮询进度，返回 204 |

`enabled` 默认 true，`intervalMinutes` 默认 30，最小 5。参数非法返回 400，实例不存在返回 404，试拉遇到网络、上游 HTTP 或内容格式错误返回 502。生产拉取只允许 HTTPS，拒绝 URL 内嵌凭证及 HTTP 重定向。每个响应最多 2 MiB，整个拉取限时 15 秒。

| 模板 | 参数 | 样例条目 |
|---|---|---|
| `rss` | `url` | RSS 2.0 和 Atom 提取 `id, title, url`，可附 `publishedAt, body`。日期保留来源格式，摘要去 HTML 后最多 500 字符 |
| `json` | `url, itemsPath?, idField, titleField, urlField, bodyField?, headers?, secrets?` | 列表与字段支持点路径。列表路径省略或为空时使用根数组。数字 ID 转为字符串，相对链接按接口地址解析 |
| `github` | `token` | 读取 GitHub 通知，条目含 `id, repo, type, title, url`。issue、PR 等链接指向网页版，缺少主题地址时回退到仓库 |

JSON 请求头可引用本实例的命名密钥。例如：

```json
{"template":"json","name":"项目公告","params":{"url":"https://example.org/news","itemsPath":"data.items","idField":"id","titleField":"title","urlField":"url","headers":{"Authorization":"Bearer ${secret:api}"},"secrets":{"api":"example-only"}}}
```

实例与进度使用数据目录中的插件加密存储。对外视图中，GitHub token 和 JSON 的每个请求头值、密钥值均以 `{"set":true}` 表示。PATCH 省略字段会保留旧值，提交 `headers` 或 `secrets` 会整体替换对应的映射，空对象可清除映射。

每批按 ID 去重。实例保存最近 1000 个 ID，大列表另外保留超出窗口部分的摘要，用于识别连续多次返回的相同历史条目。如果上游重排了窗口之外的历史，已淘汰的 ID 可能再次进入分诊。启用状态下，新建实例的试拉同时建立基线，首次拉取不推送。单独重新启用实例或修改拉取参数后，下一次成功拉取重建基线。重启服务或热重载整个插件会继续使用已保存的基线、最近 1000 个 ID 和下次轮询时间。新消息携带 `source = "feed:<实例名>"`、`author = "external"` 和 `untrusted = true`，经已有分诊流程处理。

`status.lastPollAt` 和 `status.nextPollAt` 为 Unix 毫秒。实例停用时 `nextPollAt` 为 null。全插件停用会暂停计时器。`todayCount` 是按服务时区计算的当日已送入分诊条数。`error` 在成功后为 null，失败时返回安全的错误原因。连续失败按实例间隔的 2、4、8 倍退避，最高 64 倍。GitHub 保存 Last-Modified 供下次条件请求使用，304 只更新状态，调度时间同时满足 X-Poll-Interval。

SSE 在连接、重连、实例配置或轮询状态变化时发送 `sources`，数据与 `GET /api/sources` 相同。增删或重命名实例也更新 `plugins` 事件，模板插件的 `provides.sources` 按创建顺序列出实例名称。

## 自写插件（v1.18）

| 方法 | 路径 | 输入与结果 |
|---|---|---|
| GET | `/api/ext-plugins` | 返回 `ExtPluginView[]`，含待审批、当前 SHA、历史版本、连续失败次数和来源进度摘要 |
| POST | `/api/ext-plugins/install` | `{"path":"/absolute/package"}`。201 返回 `{manifest,sha,directory,codeUrl,dependencies,summary,permissions,expanded,removed}`。首次安装与升级都需亲批 |
| POST | `/api/ext-plugins/:id/approve` | `{"sha":"…"}`。只批准当前待审批 SHA，重新校验目录内容，成功返回 204 |
| POST | `/api/ext-plugins/:id/reject` | `{}`。撤回待审包，204 |
| POST | `/api/ext-plugins/:id/rollback` | `{}` 回到上一版本，或用 `{"sha":"…"}` 指定历史版本。同步恢复该版本 KV 和来源进度，204 |
| POST | `/api/ext-plugins/:id/disable`、`…/enable` | `{}`。停用或启用已批准版本，204。隔离版本须更换代码 |
| DELETE | `/api/ext-plugins/:id` | 删除安装记录、版本、状态及密钥，204 |

以上沿用 Web 会话 Cookie 和 JSON 写接口。待审批记录无期限，独立于任务审批模型。
SSE 首连和变更发送 `ext-plugins`，数据与 GET 相同。已安装版本同时出现在 `plugins`，标识符为 `ext-<id>`。
借用能力的 broker 审计记录含 `borrower`，值为清单中的插件 ID。
密钥经已有的 `PATCH /api/plugins/ext-<id>` 写入 `settings`，读取只返回 `{set:boolean}`。

包入口是 `index.mjs`，从 `@alter/plugin-sdk` 导入 `definePlugin`，默认导出工具和来源处理器。
工具签名为 `(args,ctx)`，来源为 `(ctx)`，返回含 `id,title` 和可选 `url,body,repo,type,publishedAt` 的条目数组。
来源首次轮询建立基线，后续事件标记为外部、不可信。每批最多发送 20 条明细，超出部分合并通知。
安装响应、待审批列表和 SSE 的提案均通过 `manifest.tools[]` 提供工具的 `name`、`description` 和 `effect`。升级时核对 `pending.manifest` 中的新版本。清单 schemaVersion 为 1，工具效果只接受 `read / write / irreversible`。输入输出使用显式类型 JSON Schema 子集，支持 properties、required、additionalProperties、items、enum 和 description。未知关键字在安装时拒绝。
清单可省略 `network` 和 `requires`。`network` 的每项包含主机、HTTP 方法和字面路径前缀，仅作展示和版本差异比较。`requires` 为字符串数组，每项写明所需的外部程序或设备及用途，例如 `["adb（查询设备）", "已连接的安卓手机"]`。

`summary` 为多行文本。首行固定为「此插件以你的权限运行，可以读写文件、联网、执行命令」。其余列出插件说明、直接 npm 依赖、外部程序或设备、声明的网络用途、密钥用途、工具及其副作用、消息来源、借用能力和代码目录。`codeUrl` 是源目录的本地文件 URL。`dependencies` 将直接依赖名映射到 package.json 声明的版本或来源。

安装先将包复制到 Alter 数据目录内的待审批副本。有 npm 依赖必须提供 `package.json` 和 `package-lock.json`。有锁文件即在副本中执行 `npm ci --ignore-scripts`，失败则安装接口返回 400。审批绑定规范化文件路径和内容的 SHA-256，覆盖代码、包元数据和锁文件。源目录已有的 `node_modules` 不参与复制或哈希。批准时复核代码，启用 npm 在待审批副本中安装的依赖。每次运行前校验代码哈希，依赖目录沿用安装结果。旧沙箱版本需在新权限说明下重新亲批。

同一插件的调用串行执行，每次调用启动独立 Node 进程，通过 stdio JSON-RPC 通信。插件可直接使用 `fetch`、`fs` 和 `child_process`。子进程环境只继承 PATH、HOME、LANG、系统临时目录和 Windows 运行所需目录变量，并剔除与声明密钥同名的变量。声明的密钥全部配置后才注册工具、轮询来源。

`ctx.http.request` 提供宿主侧密钥请求头注入，跨源跳转清除请求头。代发仍限制公开 HTTPS 地址、超时、响应大小和频率，每插件每分钟最多 60 跳。只读调用期间的代发限无请求体的 GET/HEAD，查询串禁止包含密钥。宿主记录代发决策。直连请求由插件自行处理。代码哈希不符时隔离该版本。连续调用失败 5 次暂停插件，来源连续 3 次返回无效结构时暂停该来源。

`resources.memoryMB` 约束插件进程的 V8 老生代和 RSS。独立监测线程每 100 ms 采样进程 RSS，超过上限时终止该进程。宿主按 `timeoutMs` 终止超时调用。插件另行启动的外部程序自行管理其资源。

## 反馈闭环（v1.20）

回访已暂停。历史题库中每次出题都有独立的 `id`，两个渠道使用同一个 ID 作答。`candidateId` 标识题库条目，`batch` 标识同组出题。时间戳单位为 Unix 毫秒。

| 方法 | 路径 | 请求与结果 |
|---|---|---|
| GET | `/api/feedback` | `FeedbackView` 含待答 `pending`、历史 `history` 和 `changes`。题目含选项、来源、原因、结构化效果、出口、出题时间。历史记录含作答时间、选项、补充文字与 `changeIds`。 |
| POST | `/api/feedback/:id/answer` | `{"options":["部分对"],"other":"只在周末"}`。成功返回 204。单选最多选一项，多选可选多项。允许其他时可以只提交文字。使用该题实际显示的选项。猜测选“部分对”须写下修正；选“不对”并补充文字会修正条目，只选“不对”会删除。 |
| POST | `/api/feedback/:id/skip` | `{}`，返回 204。 |
| POST | `/api/feedback/more` | `{}`，暂停期间返回空数组。 |
| POST | `/api/feedback/changes/:id/undo` | `{}`，返回 204。按变更 ID 回退，并在历史记录中追加逆向变更。 |
| GET | `/api/feedback/stats` | `FeedbackStats`，含全部历史统计、对应指标的变更前后样本及每周产品反馈。 |
| GET | `/api/feedback/export` | 下载 `alter-weekly-feedback.json`，内容是 `FeedbackWeek[]`，含周汇总和用户针对新功能提交的选项与补充文字。 |

以上接口沿用会话登录和 JSON 写请求。选项非法返回 400，ID 不存在返回 404，题目已失效、另一端已提交不同答案、撤销会覆盖较新改动时返回 409。重交同一答案、重复跳过或重复撤销返回 204。SSE 在首次连接、重连及变更时发送 `feedback`，载荷与 GET 一致。内存库和主事务分别落盘期间可见短暂的 `applying` 状态，启动时继续完成。

`effect.kind` 取 `memory`、`param` 或 `metric`。记忆变更通过 `memoryAction` 区分确认、修正、删除等操作，并引用 `memoryChangeId`，可在记忆历史中查看完整快照。参数变更给出键、前值、后值；分诊和权限说明另有来源或工具 `scope`。撤销记录含 `undoOf`，原记录含 `undoneBy`。部署目录的 `feedback.sqlite` 提供可直接查询的 `feedback_questions`、`feedback_issues`、`feedback_changes` 和 `feedback_param_changes`。这些表从主事务的已提交状态恢复。

暂停期间取消每周回访调度，手动取题和报告均停止出题。已有待答题仍可作答或跳过，历史记录、撤销和统计接口继续可用。旧的 `reportFrequency` 偏好保留在存储中。

改写题的 `optionMap` 将显示选项映射到原选项，参数效果的 `mapping` 直接以显示选项为键。某题映射验证失败时使用该题模板。带补充的猜测修正会合并为短标题和完整正文，模型不可用或输出无效时按用户原话保存，均可撤销。

回答率与跳过率的分母是实际出题次数，含待答和已失效题。按来源和单选、多选分别汇总。猜测确认率为回答“对”的次数除以猜测题的作答次数。“部分对”计入分母。满意度按不满意、一般、满意记为 1–3，有用率按有用、没用记为 1、0。“还没看”和单独填写的其他文字保留在历史中。撤销保留作答事实和原始变更数，已撤销的指标样本退出时间序列。变更前后各取七天，同时返回样本数，缺少样本时均值为 null。每周汇总按配置时区的周一分组。

事件通知可带原始事件类别 `category`。新分诊偏好用来源和类别的 JSON 二元组字符串作键，旧记录沿用来源名。无需主事务时也可通过 `await app.settings.feedback()` 读取回访参数。参数答案与当前值相同且没有新的记忆变更时，`changeIds` 为空。

飞书使用卡片 JSON 2.0 表单。提交按钮通过 `card.action.trigger` 回传整张表单，服务端核对已配对的用户和已发送卡片的消息 ID。[飞书表单容器](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/form-container)

## v1.21 唤醒、定时安排与近况报告（#94）

- `GET /api/schedules`、`GET /api/state` 和 `schedules` SSE 中的每项都提供 `type: "reminder" | "task" | "wake"`。保留同值的旧字段 `action` 供现有客户端读取。旧安排保留 ID、暂停状态和到期时间。三个类型分别直接通知、直接派任务、唤醒主会话。
- 主会话通过 `schedule_create({ type, trigger, brief, thinking?, continue_from? })` 创建，`schedule_list({})` 查看，`schedule_set({ id, trigger?, brief?, thinking?, status? })` 修改。状态接受 `active | paused | deleted`。任务中断工具为 `task_stop`，可用 `dispatch_task` 的 `continue_from` 接续。
- `GET /api/heartbeat` 增加 `report: { intervalDays, activeDays, time, nextAt, paused }`。活跃天数按用户时区统计最近七个日历日，计入聊天、审批、通知读回执与反馈、Web 登录和显式写操作。SSE 重连和后台轮询不计入。每晚检查一次，`intervalDays` 固定为 1。首次检查在安装后的第一个报告时刻。时间采用 `ALTER_REPORT_TIME`（默认 21:00），落在巡检窗外时取窗内时刻。`nextAt` 为 Unix 毫秒，长期无互动或在下次报告前将进入暂停时为 null。连续 168 小时无互动时暂停巡检和报告。恢复互动后继续晚间检查。巡检跳过原因增加 `inactive`。
- `heartbeat` SSE 增加 `{ type: "report", report }`，报告设置变化时同步。重连时读取 `GET /api/heartbeat`。唤醒统计增加 `triage` 和 `report-due` 两种来源。主会话决定是否将分诊的 now 事件转告用户，投递规则见 v1.25。报告通知的 source 为 report。分诊事件保留在通知记录中，漏斗的 pushed 仅将有投递凭据的历史 now 事件算作已推送。
- 自上次发送报告以来，任务账本中至少有两个不同的已完成任务才生成报告。摘要消息不计入门槛。任务和摘要游标在主会话显式发送报告时一并推进，未发送的内容留到下次检查。
- 报告从通知中心取出游标之后仍保留的摘要，排除报告自身。任务模型低思考强度调用一次，忽略低价值通知、按主题合并为中文短句，每行末尾附经核对的来源 ID（优先用 `ref`）。模型失败、超时或格式无效时沿用原始摘要行。主会话可用只读工具 `digest_source({ ids: [...] })` 查看对应的来源、标题、完整正文、引用和时间。
- `ALTER_DIGEST_TIME` 已废弃。目标复查和固定每日摘要停止调度，审批最终过期通过任务报告反馈。历史统计仍可含 goal 角色。

## v1.22 主会话租用统计（#95）

`GET /api/state` 的 `leases[].capability` 在整组租用时为能力名（如 `mail`），单动作租用时为 `能力名/动作名`（如 `mail/read`）。

`GET /api/stats` 新增 `leases`。按成功取得租约的时间筛选，续租另计一次；拒绝、超时和常驻工具不计入。拒绝与超时仍可从审批记录查看。升级前的租用没有历史明细。

- `count` 是租约数。`byTool` 按实际注册的工具名计算被租次数，整组租用时组内每个工具各计一次。
- `items` 按取得时间倒序，含租约 ID、能力、工具列表、理由、时间、发起回合的 `wakeId` 和是否经用户批准（`approved`）。`calls` 是该租约下 Broker 已放行的调用数；`succeeded` 和 `failed` 是已收到结果的成功和失败数。审批挂起、拒绝和恢复重放不增加调用数。单动作与整组租约重叠时，调用归单动作租约。
- `dispatchAfterLeaseRate` 是有效期内主会话成功执行过 `dispatch_task` 的租约占比，分子按租约去重。并存租约可关联同一派单，指标不判定派单原因。两项比例的分母均为 `count`，零分母返回 `null`。
- 用 `wakeId` 和 `useWakeIds` 分别关联取得租约及实际使用工具的回合，按去重后的回合 ID 从 `wakes.items[].usage` 取主会话 token。派单次数、任务 token 和结果见 `tasks`。同一回合可能同时租用和派单。

## v1.24 工具转接器（#122）

网页使用现有会话 Cookie。所有写请求带 `Content-Type: application/json`。

| 方法与路径 | 请求体 | 成功响应 |
|---|---|---|
| `GET /api/adapters` | — | `200 AdapterView[]` |
| `POST /api/adapters` | `{ id, kind, name, config, secrets? }` | `201 AdapterView`，默认启用，已尝试发现工具 |
| `PATCH /api/adapters/:id` | `{ name?, enabled?, config?, effects?, secrets? }` | `200 AdapterView`，立即更新注册 |
| `POST /api/adapters/:id/refresh` | `{}` | `200 AdapterView`，启用时重新发现 |
| `DELETE /api/adapters/:id` | 可省略 | `204`，清理注册、连接、重连定时器和该项的密钥 |

`id` 为 1–48 个小写英文字母、数字或短横线，跨种类唯一。配置字段无效返回 `400`，未登录返回 `401`，未知 ID 返回 `404`，ID 冲突返回 `409`。连接或发现失败时，配置仍保存，响应的 `status.state` 为 `error`，原因见 `status.detail`。失败或停用期间保留最近一次成功发现的快照，停止提供对应工具。

```ts
type Effect = "read" | "write" | "irreversible";
type Strings = Record<string, string>;
type Definition =
  | { kind: "mcp"; config: { transport: "stdio"; command: string; args?: string[]; env?: Strings; readOnly?: boolean }
                         | { transport: "http"; url: string; headers?: Strings; readOnly?: boolean } }
  | { kind: "cli"; config: { command: string; args?: string[]; env?: Strings; cwd?: string; help?: string; timeoutMs?: number } }
  | { kind: "http"; config: { spec: string | Record<string, unknown>; baseUrl?: string; headers?: Strings } };
type AdapterView = Definition & {
  id: string; name: string; enabled: boolean; capabilityId: string;
  status: { state: "connecting" | "ok" | "error" | "off"; detail?: string };
  effects: Record<string, Effect>; secretNames: string[];
  tools: { name: string; description: string; inputSchema: Record<string, unknown>; defaultEffect: Effect; effect: Effect }[];
};
```

`config` 和 `effects` 按字段整体替换。覆写表用 `tools[].name` 作键，省略某个键即可恢复该工具的默认效果。完整调用名为 `${capabilityId}_${name}`，最长 64 个字符。`secrets` 按名字增量更新，空字符串删除，名字支持字母、数字、短横线和下划线。参数、环境变量、标头或 URL 可以包含 `{{secret:NAME}}`。视图只提供配置模板和已设置的密钥名。

- **MCP** 使用 stdio 或 Streamable HTTP。旧服务在 HTTP 协议协商失败时可回退至 SSE。分页发现工具并保留原始输入 schema，显式 `readOnlyHint: true` 默认为 `read`，其余为 `write`。断线自动重连。文本按换行拼接，图片透传，`isError` 进入工具结果。
- **CLI** 提供 `run({args: string[], stdin?: string})`，默认 `write`。固定参数位于调用参数之前，缺少帮助文本时在固定参数后追加 `--help`。帮助最多 8000 字符。默认超时 120000 毫秒，可设为 1–600000 毫秒。返回 JSON 文本 `{code, signal, output}`，其中 `output` 是 stdout 与 stderr 的合并内容，最多 20000 字符；非零退出码标记为工具错误。
- **HTTP** 接受 OpenAPI 3 JSON 文档 URL、JSON 对象或内联 JSON 字符串。默认用首个 server URL，远程文档的相对 URL 按文档地址解析。配置的 headers 用于获取文档和执行调用。工具参数平铺 path、query、header 参数，JSON 请求体放在 `body`，同名参数用位置前缀区分。支持文档内引用。GET 和 HEAD 默认 `read`，其余默认 `write`。工具返回 JSON 文本 `{status, body}`，正文保留为字符串，最多 20000 字符；HTTP 错误保留状态码和正文。

通用插件列表 `GET /api/plugins` 同时展示转接器。连接状态和启停变化也更新现有 `plugins` SSE。转接器管理页可通过 `GET /api/adapters` 重新读取快照。

## v1.25 主会话默认回复与静默（#133）

主会话成功结束时，框架将最后一条 assistant 答案中的文本块合成全文。非空且未静默时，只写入一条 `kind: "message"`、`level: "now"` 的通知。`body` 为全文，`title` 为首行前 60 个字符。中间工具轮的文字保留为草稿。最终答案为空或仅含空白时跳过投递。

用户触发的回合使用原渠道（`web`、`feishu` 或 `cli`）。系统唤醒使用默认通知渠道，已配对的飞书账号可收到全文。网页时间线可查看所有渠道的消息。飞书沿用现有通知的去重与投递回执。

`GET /api/state` 和 `timeline` SSE 共用条目 ID。已发送的最终正文为 `kind: "message"`，客户端按 ID 替换先前的流式草稿。主会话调用 `stay_silent({ reason? })` 后，本轮各段正文显示为 `kind: "assistant", silent: true`，提供原因时带 `reason`。静默回合的派单带 `originSilent: true`，其报告仍由主会话决定是否发送。

`GET /api/stats` 的 `silent` 取代 `unreplied`。空正文不自动计为静默，重复调用按一轮统计，账本停止新增未回复记录。

## v1.26 调试模式（#132）

四个只读接口使用现有登录 Cookie，未登录返回 401，响应带有 `Cache-Control: no-store`。时间戳为 Unix 毫秒。读取调度说明不会触发模型调用或刷新用户活跃时间。

| GET 路径 | 返回值 |
|---|---|
| `/api/debug/traces?conversation=main&trigger=heartbeat&limit=50&before=<cursor>` | `{ items: DebugTraceSummary[], nextCursor: string 或 null }`。默认主会话，省略 trigger 包含全部来源。conversation 可取 main、task（所有任务）或具体 conversationId。按调用时间、ID 倒序，下一页原样传回游标并保留筛选条件。limit 范围 1–100，默认 50，非法游标或数量返回 400 |
| `/api/debug/traces/:id` | `DebugTrace`，包含摘要、完整有序的 messages、systemPrompt、tools、请求 options、output、toolResults、promptHash 和 toolsHash。不存在或已清理返回 404 |
| `/api/debug/prompts/:hash` | `{ hash, kind, content }`。system 的 content 是提示词字符串，tools 的 content 是工具定义数组，含 name、description、parameters。未知哈希返回 404 |
| `/api/debug/schedule` | `DebugSchedule`，字段有 timeZone、heartbeat、report、scheduledTasks、memory、watch 和 feedback，各机制提供中文 reason |

**调用与输入。** 每次尝试独占一个数字 ID。摘要含会话类别及 ID、可取得的任务 ID、wakeId、wakeAt、触发条目的 entryId 与 entryKind。trigger 沿用唤醒来源，包括 `user-web`、`user-feishu`、`user-cli`、`heartbeat`、`schedule`、`report-due`（近况报告）、`report`（任务回投）、`watch`、`triage` 和 `approval`。主会话整理上下文的调用标为 `compaction`。网关的 `format=gateway` 保存请求体里的消息顺序与工具参数 schema，包含提供方的格式转换。其他模型或尚未构造出请求体的失败尝试用 `format=transcript` 表示 SDK 的请求上下文。

**结果与用量。** outcome 为 pending、ok 或 error。pending 表示尚未记录终态，进程中断也可留下此状态。output 的 content 保留 SDK 返回的 thinking、text、toolCall 块。工具执行提交后，toolResults 以 toolCallId 关联输出，text 限 20,000 个 UTF-16 码元，超过时 truncated 为 true。模型失败或任一工具执行失败均使 isError 为 true。tokens.input 是未缓存输入，cacheRead 与 cacheWrite 分列，reasoning 是 output 的子集。缺失用量表示模型未报告。latencyMs、firstTokenMs 单位均为毫秒，后者取首次输出流事件。attempt 从 1 开始，切换模型时 fallback 为 true，同模型重试可通过 attempt 和 fallbackFrom 识别。

**调度。** heartbeat.configured 对应设置开关，enabled 表示实际已排程。start、end 使用 timeZone 的本地时间。lastAt 是上次实际巡检时间，nextAt 是调度器选定的下次时间。intervalMs 是当前采用的间隔。lastDecision 保存选定间隔时的输入、demand、factor、rawMs、上下限与 clamped，首次或旧版记录可为 null。current 用最新信号试算，摘要被消费、收到新消息或更新反馈后，两者可能不同。report 返回间隔天数、检查时间、最近七天活跃天数、暂停状态、上次检查和下次时间。scheduledTasks 包含各项的触发规则，memory 给出累计轮数、阈值和空闲等待，watch 给出补拉与合批周期及活动盯梢的截止时间，feedback 给出回访状态。nextAt 为 null 表示当前没有下一次排程。

前端调用 `api.debugTraces(query?)`、`api.debugTrace(id)`、`api.debugPrompt(hash)` 和 `api.debugSchedule()`。调试数据随本机保留策略清理，默认保留 14 天。见 [ADR-0024](../adr/0024-debug-traces.md)。

## v1.27 GitHub 转接器预设（#142）

| 方法与路径 | 请求体 | 成功响应 |
|---|---|---|
| `GET /api/adapters/presets` | — | `200 AdapterPreset[]`，每项包含 `id`、`name`、`description`、`authMethods` 和 `variants` |
| `POST /api/adapters/presets/:id` | `{ auth, token?, variant?, id?, name? }` | `201 AdapterView`，保存配置并立即尝试连接 |

路径中的 `id` 标识预设，目前为 `github`。请求体中的 `id` 和 `name` 标识新建的转接器，默认分别为 `github` 和 `GitHub`。网页通过 `api.adapterPresets()` 列出选项，通过 `api.createAdapterFromPreset("github", { auth: "gh" })` 使用本机登录。两个接口均需登录。创建沿用普通转接器的校验和冲突处理，预设不存在返回 404。

| `variant` | MCP URL | 发现工具时的默认效果 |
|---|---|---|
| `readonly`（默认） | `https://api.githubcopilot.com/mcp/readonly` | 配置设置 `readOnly: true`，所有工具默认为 `read` |
| `full` | `https://api.githubcopilot.com/mcp/` | 仅 `readOnlyHint: true` 默认为 `read`，其余为 `write` |

`auth: "token"` 要求提供非空 `token`，服务端将其存为该转接器的加密密钥 `GITHUB_TOKEN`。视图中的 Authorization 为 `Bearer {{secret:GITHUB_TOKEN}}`。`auth: "gh"` 使用 `Bearer {{gh-token}}`。服务端每次连接、刷新或重连时按需执行一次 `gh auth token`，超时 10 秒，凭据只保存在本次连接的内存中。获取失败时返回已创建的转接器，`status.state` 为 `error`，`status.detail` 为「本机 gh 未登录或不可用，请运行 gh auth login」。

手动配置也可在固定参数、环境变量、请求头和 URL 中使用 `{{gh-token}}`。MCP 的 `config.readOnly` 只设置默认工具效果，显式的逐工具 `effects` 覆写始终优先。GitHub 只读预设通过所选远程端点限制工具集。

## v1.28 我的电脑（#149）

节点管理沿用网页鉴权，响应禁止缓存。时间戳为 Unix 毫秒。

| 方法 | 路径 | 请求与响应 |
|---|---|---|
| GET | `/api/nodes` | 配对记录数组，每项含 `id, name, createdAt, online, platform, harnesses, roots, lastSeen`。首次连接前平台及最近在线时间为 `null`，两个列表为空。代理项沿用节点协议的 `Harness`，用 `available` 判断可用性。 |
| POST | `/api/nodes` | 提交 `{name}`，成功返回 201 和 `{id, token, installCommand, pairCommand, pairCommandPowerShell, rootCommand, runCommand}`。名称重复返回 409。token 只在这次响应中提供。 |
| DELETE | `/api/nodes/:id` | 204，立即吊销 token 并关闭连接，未结束的任务生成失败报告。未知 ID 返回 404。 |
| WS | `/api/node/connect` | 使用 `Authorization: Bearer <userId>.<secret>`，校验通过后通过 hello / welcome 建立会话。无效 token 收到 rejected 后断开。 |

安装、配对和启动命令在含节点程序的 Alter 源码根目录执行，使用 Node 24 和仓库的 pnpm。POSIX shell 使用 `pairCommand`，PowerShell 使用 `pairCommandPowerShell`。首次配对后，将 `rootCommand` 的路径占位符替换为允许代理操作的项目目录，执行后再运行 `runCommand`。网页创建配对时使用浏览器的 Origin 生成服务地址。hub 在实例的持久化数据库里保存 secret 的 SHA-256 哈希，首次 hello 绑定节点本地的设备 ID。节点管理接口和任务 runner 使用稳定的配对记录 ID，在首次上线前也可以排队。

离线派单在 `/api/state`、SSE tasks 和 `task_status` 中显示为 `queued`。节点任务的 transcript 包含正文、思考、工具调用、工具结果及状态。报告沿用 Ledger 和主会话的报告唤醒；`interrupted` 表示中断。节点审批能力名为 `node:<harness>`。断线期间仍可处理审批，节点重连后收到已有决定。

WebSocket 消息结构以 `packages/node-protocol/src/index.ts` 为准。任务开始消息只携带 brief 和执行参数，需要节点读取的背景须写入 brief；接续任务使用上次的原生会话 ID。

## v1.30 节点代理已有会话

`GET /api/nodes/:id/sessions?harness=dsh` 查询在线节点的已有会话。必填的 `harness` 接受 `claude-code`、`codex`、`opencode`、`dsh`（DeepSeek Harness）。可选查询参数 `cwd` 按节点上的目录筛选。节点资料中代理的 `available` 和 `sessions` 均为 true 时可查询。

成功返回 200 和按更新时间从新到旧排列的数组，每项含 `sessionId`、`cwd`，以及可选的 `title`、`updatedAt`（Unix 毫秒）。空列表为 `[]`。harness 缺失或无效返回 400，节点未知返回 404，代理不支持查询返回 409，节点报告查询失败返回 502，电脑离线返回 503，等待节点回复超过 25 秒返回 504。

主会话用 `node_sessions` 查到的 `sessionId` 可作为 `dispatch_task` 的 `runner.session`。任务记录保留此次指定的会话，后续 `continue_from` 使用任务结束时返回的 `nativeSessionId`。
