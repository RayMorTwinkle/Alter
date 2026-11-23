# Web API 契约（v1.12）

Web 前端（`packages/web`）与服务端（`packages/server`）之间的接口。服务端只用 Node 内置模块（`node:http`），推送用 SSE。

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
| `ALTER_APPROVAL_MODEL` | `shadow` | 首次启动使用的审批模式，已保存的 settings.json 优先 |
| `ALTER_WEB_PASSWORD` | 无（必填） | 单用户登录密码 |
| `ALTER_FEISHU_APP_ID` / `ALTER_FEISHU_APP_SECRET` | 无 | 同时设置以启用飞书机器人入口与用户账号 Connector |
| `ALTER_FEISHU_REDIRECT_URI` | `http://127.0.0.1:<ALTER_WEB_PORT>/api/feishu/oauth/callback` | 端口默认 4317，与开放平台登记值完全一致 |
| `ALTER_FEISHU_DOMAIN` | `feishu` | 国际版用 `lark` |

服务端同时托管前端构建产物（`packages/web/dist`），开发时前端用 Vite 代理 `/api`。

飞书自建应用需启用机器人，并在开放平台为事件和回调选择长连接。订阅消息事件 `im.message.receive_v1` 和卡片回调 `card.action.trigger`。在机器人私聊中发送配对码即可绑定。

### 飞书用户账号

在开放平台自建应用的「安全设置 → 重定向 URL」登记 `http://127.0.0.1:4317/api/feishu/oauth/callback`。浏览器必须能访问此地址。改用其他端口、域名或反向代理时，登记实际回调地址，并将 `ALTER_FEISHU_REDIRECT_URI` 配置为同一值。

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

## 数据类型

```ts
type TimelineItem = {
  id: string;                 // 稳定 ID（条目 ID 或提交 ID），前端据此去重
  kind: "user" | "assistant" | "report" | "permission" | "notice";
  text: string;
  at: number;                 // 毫秒时间戳
  taskId?: string;            // report / permission 关联的任务
  source?: string;            // v1.4：user 项带来源；web / feishu，旧记录返回 web
  model?: string;             // assistant：实际作答的模型
};

type Task = {
  taskId: string;
  brief: string;
  context: "fork" | "fresh";
  heartbeatAt?: number; heartbeatId?: string;
  continuedFrom?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  permission: "restricted" | "auto" | "full";
  allow: string[];            // 兼容旧客户端，恒为空数组
  status: "running" | "completed" | "failed";
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
  tainted?: true;             // v1.2 新增，调用受污点规则约束
  taint?: { source: string; capability: string; at: number }; // 首次不可信结果的工具名、能力和 Unix 毫秒时间
  expiresAt: number;          // v1.1 新增，截止时间（Unix 毫秒）
};

type FeishuPairing = ({ paired: true } | { paired: false; code: string; expiresAt: number }) // Unix 毫秒
  & { account: { connected: boolean; name?: string } };

// v1.3 新增，仅在加载了日历插件时提供
type AgendaEvent = { id: string; title: string; start: number; end: number; allDay: boolean; location?: string; notes?: string };
type Agenda = { timeZone: string; events: AgendaEvent[] }; // 今天起 7 个本地日内的日程，按开始时间排序；全天日程 end 不含

type Notification = {
  id: string; at: number; kind: "reminder" | "event" | "digest" | "goal" | "notify"; level: "now" | "digest" | "silent";
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

type LedgerEntry = { taskId: string; summary: string; refs: { kind: string; ref: string }[]; at: number };

type TranscriptItem =
  | { kind: "user" | "assistant"; text: string; at: number }
  | { kind: "tool_call"; tool: string; arguments: unknown; at: number }
  | { kind: "tool_result"; tool: string; text: string; isError: boolean; at: number };
```

## 接口

| 方法 | 路径 | 返回 |
|---|---|---|
| `GET` | `/api/state` | `{ timeline: TimelineItem[], tasks: Task[], pending: PermissionRequest[], ledger: LedgerEntry[], notifications: Notification[], leases: { capability: string; idleTurns: number; window: number }[], busy: boolean }` |
| `POST` | `/api/messages` | 请求 `{ text }` → `202 { id }`；主会话忙时排队，不报错 |
| `POST` | `/api/permissions/:id` | 请求 `{ decision: "once" &#124; "statement" &#124; "task-full" &#124; "deny", note?: string }` → `204`。已处理、已到期或对主会话租约选择任务级授权返回 `409`。旧客户端可用布尔字段 `allow` 提交单次批准或拒绝 |
| `GET` | `/api/tasks/:taskId/transcript` | `{ items: TranscriptItem[] }` |
| `POST` | `/api/stop` | 停止主会话当前回合 → `204` |
| `GET` | `/api/funnel?days=7` | `Funnel`（v1.8）。需要登录，默认 7 个本地日，支持 1–366 天。非法或重复的 `days` 返回 `400` |
| `GET` / `PATCH` | `/api/settings` | 返回 `{ approvalModel }`。更新时提交同形对象，值为 `shadow`、`auto` 或 `off`，非法值返回 `400` |
| `GET` | `/api/approvals/stats` | `{ compared, agreed, agreementRate, deniedButInScope }`。仅统计同时有模型判断和用户决定的请求。一致率为 0–1，没有可对照样本时为 null |
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
| `GET` | `/api/calendar` | `Agenda`（v1.3）；未加载日历插件时 `404` |
| `POST` | `/api/notifications/:id` | 更新已读或反馈 → `204`。请求至少含 `status`（仅 `read`）或 `feedback`（`useful` 或 `useless`）之一。无效字段返回 `400`，未知或已淘汰的 ID 返回 `404` |
| `GET` | `/api/memory` | `MemoryItem[]`，按 `updatedAt` 倒序。读取时将已过期的 active 目标转为 pending |
| `PATCH` | `/api/memory/:id` | 请求至少含 `text`、`status`、`due` 之一 → `204`。期限仅适用于目标，使用 Unix 毫秒，传 `null` 可清除。字段无效返回 `400`，记忆不存在返回 `404` |
| `DELETE` | `/api/memory/:id` | 删除记忆 → `204`；记忆不存在返回 `404` |
| `GET` | `/api/events` | SSE，见下 |

v1.10 中，`once` 批准卡片上的具体调用。`statement` 批准本次调用并保存卡片上的说明快照，后续追加项需再次获批。`task-full` 对当前任务放行所有后续调用，包括不可逆操作。`deny` 拒绝当前调用，并阻止同任务重试该工具。主会话租约支持 `once` 和 `deny`。

`auto` 在默认等待时间到达时按说明处理。范围外、不可逆或副作用未知的调用返回“暂未获批”。随后批准可供同一任务下一次相同工具与参数使用。`shadow` 记录判断并等待用户至最终到期。`off` 关闭模型，任务在默认等待时间后可先做其他工作。飞书与 Web 共用一次性决定。任务授权随任务 ID 结束。

漏斗按通知的 `at` 归到用户本地日期，从早到晚列出截至今天的每一天，空日补零。统计基于当前保留的最近 500 条通知，淘汰的记录无法计入。事件计入 `triggered`，通过预过滤的事件计入 `passed`。配置飞书时，`pushed` 只计已有 `pushedAt` 的 `now` 事件；未配置时计所有 `now` 事件。已读和两种反馈独立统计事件的当前状态。摘要和提醒仅计入 `digests`、`reminders`。窗口内的打扰精准率为有用数除以有反馈的事件数，无反馈返回 `null`。

v1.7 的通知列表按写入顺序从新到旧保留 500 条。`at` 为实际投递到通知中心的 Unix 毫秒时间。按用户本地时间，23:00（含）至次日 08:00（不含）触发的提醒记为 `digest`，其余记为 `now`。已配对的飞书私聊推送新的未读 `now` 通知。读状态和反馈可独立更新，重复提交同一值仍返回 `204`。

v1.5 的记忆接口使用登录会话。网页上的修改和删除由用户直接执行。

`timeline` 返回最近 200 条；更早的用 `GET /api/state?before=<id>` 分页（v1 可不实现）。

## 调用、任务与唤醒统计（v1.11）

完整 TypeScript 返回类型见 [Stats](../../packages/web/src/types.ts)。`at` 是服务端采样时的 Unix 毫秒时间。窗口按用户配置时区的本地日期计算，包含今天，截至 `at`。`daily` 由早到晚补齐空日。`all` 从最早有记录的本地日期开始，空库返回今天一行。

| 字段 | 统计口径 |
|---|---|
| `total`、`byRole[]`、`byModel[]`、`daily[].usage` | 按调用开始时间累加模型尝试。角色为可扩展字符串，如 `main`、`task`、`triage`、`goal`、`judge`、`watch`、`heartbeat` |
| `tasks` | 按创建时间筛选任务，明细含截至采样时的用量、模型、思考强度、轮数、工具名与次数、耗时、审计条目、结果摘要、`continuedFrom` 和发起派单的 `wakeId`。成功率为完成数除以已结束数，失败和取消均计入分母，分母为零返回 `null` |
| `wakes` | 按实际开始的主会话回合筛选。来源示例为 `user-web`、`user-feishu`、`user-cli`、`report`、`approval`、`schedule`。同一次唤醒内的工具循环和回退共用 ID。多条输入同时启动一个回合时取第一条来源。用量只合计该主会话回合；派单数由任务创建记录关联。单纯投递通知不产生唤醒 |
| `approvals` | `decisions` 按窗口内的 Audit 时间分别计数，`park` 表示曾等待审批，`allow` 和 `deny` 包含自动策略决定。`pending` 为采样时待处理的请求。四种用户决定、模型判断、按说明处理和最终过期分别计数，详见下文 |
| `latency` | `firstToken` 与 `total` 各返回 `samples / p50Ms / p95Ms`。用毫秒最近秩计算，只纳入相应延迟已上报的尝试，无样本时分位数为 `null` |
| `funnel`、`watchWakeAccuracy` | 漏斗复用 `/api/funnel` 的通知保留与投递规则。当前缺少盯梢唤醒反馈，准确率为 `null` |
| `topTasks`、`daily` | 费用可确定的任务按美元降序取前十，金额相同按任务 ID 排序。日序列还给出当日创建的任务数、其中已完成数、当日唤醒数 |

**审批统计。** `userDecisions` 分别统计 `once / statement / task-full / deny`；`judgments` 统计审批模型的 `inScope / outOfScope`。每个请求的判断和用户决定都到齐时进入 `shadow`，采用与 v1.10 的 `/api/approvals/stats` 相同的四个字段和比较规则。`shadowAgreementRate` 为 `shadow.agreementRate` 的便捷字段。按各事件的实际时间归入窗口，配对取两者中较晚的时间。v1.10 留存的无时间戳事件仅计入 `all`。

`byApprover` 固定返回三行：`user` 计用户实际提交的决定；`judge` 计已批准说明范围内由模型直接放行的调用；`timeout` 与 `timeouts` 都计 `auto` 模式软超时后按说明放行或暂缓的次数。影子判断只进入判断和配对统计。软超时后用户补批会再产生一次用户决定；最终过期单独计入 `expired`。旧记录无法区分软超时与直接放行的部分不追溯归类。任务的 `reviews` 按请求 ID 关联用户选择、模型结论、暂缓或过期及时间；任务用量含关联的 judge 调用，任务工具和轮数只计执行任务的模型。

每个用量对象含 `calls / input / cacheRead / cacheWrite / output / tokens / cacheHitRate / costUsd / errors / aborted / fallbacks / retries`。`tokens` 是四类 token 之和，命中率用累计的 `cacheRead / (input + cacheRead + cacheWrite)`。只汇总已报告 token。旧行的合并输入计入 `input`；分组包含无法拆分的正输入或分母为零时，命中率为 `null`。主动中止计入 `aborted`，供应商失败计入 `errors`。切换模型的后续尝试计入 `fallbacks`，显式重试同一模型计入 `retries`。网关关闭了 SDK 内部自动重试。

费用在写入时用数据目录下可选的 `prices.json` 估算。文件格式为 `Record<模型 ID, { input: number, cacheRead: number, cacheWrite: number, output: number }>`，单位为美元／百万 token。默认价格表为空。缺少价格、缺少用量或分组内任一尝试无法估价时，`costUsd` 为 `null`。修改价格影响后续调用，历史估价保留。

任务 `rounds` 按逻辑模型调用计数，同轮的备用尝试单独计入 `usage.calls`。工具计数按模型发出的工具调用计，包括被拒绝的调用。任务无可关联用量行时，按该任务简报到结束条目之间的持久化对话恢复模型、轮数、工具和已报告 token，标为 `usageSource: "transcript"`。对话只保留终态回答，无法还原中间回退；这些恢复值仅用于任务明细。缺少历史唤醒 ID 的调用仅计入调用汇总。

<details>
<summary>离线网关的一次 Web 唤醒：GET /api/stats?range=day 完整响应</summary>

```json
{
  "range": "day",
  "timeZone": "Asia/Taipei",
  "at": 1795399200000,
  "total": {"calls": 1, "input": 6, "output": 3, "cacheRead": 2, "cacheWrite": 0, "tokens": 11, "costUsd": null, "cacheHitRate": 0.25, "errors": 0, "aborted": 0, "fallbacks": 0, "retries": 0},
  "byRole": [{"role": "main", "calls": 1, "input": 6, "output": 3, "cacheRead": 2, "cacheWrite": 0, "tokens": 11, "costUsd": null, "cacheHitRate": 0.25, "errors": 0, "aborted": 0, "fallbacks": 0, "retries": 0}],
  "byModel": [{"model": "offline/main", "calls": 1, "input": 6, "output": 3, "cacheRead": 2, "cacheWrite": 0, "tokens": 11, "costUsd": null, "cacheHitRate": 0.25, "errors": 0, "aborted": 0, "fallbacks": 0, "retries": 0}],
  "tasks": {"count": 0, "completed": 0, "terminal": 0, "successRate": null, "items": []},
  "wakes": {"count": 1, "bySource": {"user-web": 1}, "items": [{"wakeId": "wake-19", "wakeSource": "user-web", "wakeAt": 1795399200000, "usage": {"calls": 1, "input": 6, "output": 3, "cacheRead": 2, "cacheWrite": 0, "tokens": 11, "costUsd": null, "cacheHitRate": 0.25, "errors": 0, "aborted": 0, "fallbacks": 0, "retries": 0}, "dispatchedTasks": 0}]},
  "approvals": {"decisions": {"park": 0, "allow": 0, "deny": 0}, "pending": [], "userDecisions": {"once": 0, "statement": 0, "task-full": 0, "deny": 0}, "judgments": {"inScope": 0, "outOfScope": 0}, "byApprover": [{"approver": "user", "count": 0}, {"approver": "judge", "count": 0}, {"approver": "timeout", "count": 0}], "timeouts": 0, "expired": 0, "shadow": {"compared": 0, "agreed": 0, "agreementRate": null, "deniedButInScope": 0}, "shadowAgreementRate": null},
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
| `snapshot` | 同 `/api/state` | 首次连接与重连时 |
| `timeline` | `TimelineItem` | 新条目（含用户自己发的消息回显） |
| `delta` | `{ id: string; text: string }` | 主会话正在生成的回答，`text` 为**累计全文**，结束时由同 `id` 的 `timeline` 条目取代 |
| `tasks` | `Task[]` | 任务列表整体替换 |
| `pending` | `PermissionRequest[]` | 待审批列表整体替换 |
| `ledger` | `LedgerEntry[]` | 账本整体替换 |
| `busy` | `{ busy: boolean }` | 主会话是否在生成 |
| `notifications` | `Notification[]` | v1.7 新增。提醒触发、已读或反馈更新时整体替换，首次连接与重连由 snapshot 提供 |
| `heartbeat` | `{ type: "start" 或 "end", id }`、`{ type: "feedback", id, feedback }` 或 `{ type: "schedule", nextAt }` | 巡检开始、结束（含跳过或顺延）、反馈或下次时间变化。收到事件及重连后读取 `GET /api/heartbeat` |
| `memory` | `MemoryItem[]` | v1.5：工具写入、网页修改或删除、读取触发过期转换后推送全量列表。首次连接与重连后请求 `GET /api/memory` 获取当前列表 |
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
| `notified, finalReply` | 是否成功写入了面向用户的通知（立即或摘要），以及主会话本轮最后回复。巡检简报、回复正文与流式片段均在 Web 对话中隐藏。工具调用仍可显示为时间线提示 |
| `tokens, feedback` | 本轮主会话对话中模型报告的 token 总数（含缓存），以及对本轮的直接反馈 `useful / useless / null` |

主会话自行决定是否告知用户、派任务、开盯梢、另寻线索或什么都不做。`notify` 写入来源为 `alter` 的通知，遵循立即投递与安静时段规则。报告、调度的普通回复进 Web 时间线，飞书用户消息照常回到原渠道。巡检及其派单的请求按 `role: "heartbeat"` 计入每日主动预算，主会话的唤醒来源为 `heartbeat`。
