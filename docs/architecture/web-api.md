# Web API 契约（v1.7）

Web 前端（`packages/web`）与服务端（`packages/server`）之间的接口。服务端只用 Node 内置模块（`node:http`），推送用 SSE。

## 运行

| 变量 | 默认 | 说明 |
|---|---|---|
| `ALTER_TZ` | `Asia/Shanghai` | 提醒与每日重复使用的用户时区 |
| `ALTER_WEB_HOST` | `127.0.0.1` | 只监听本机；需要局域网访问时显式改 |
| `ALTER_WEB_PORT` | `4317` | |
| `ALTER_APPROVAL_TIMEOUT_MINUTES` | `1440` | 两类审批的等待时长，修改只影响新请求 |
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
  permission: "restricted" | "auto" | "full";
  allow: string[];
  status: "running" | "completed" | "failed";
  failure?: string;
  conversationId: string;
  createdAt: number;
  pending: PermissionRequest[];
};

type PermissionRequest = {
  id: string;
  taskId: string;
  // 主会话自己的租约审批使用 taskId = "main"，只出现在顶层 pending
  audience: "main" | "user";  // 只有 user 的请求在网页上可操作
  capability: string;
  tool: string;
  arguments: unknown;         // 解析后的参数
  reason: string;
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
  id: string; at: number; kind: "reminder"; level: "now" | "digest" | "silent";
  title: string; body?: string; source: "schedule"; status: "unread" | "read";
  feedback?: "useful" | "useless";
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
| `POST` | `/api/permissions/:id` | 请求 `{ allow: boolean, note?: string }` → `204`；非用户受众、已到期或已处理 `409` |
| `GET` | `/api/tasks/:taskId/transcript` | `{ items: TranscriptItem[] }` |
| `POST` | `/api/stop` | 停止主会话当前回合 → `204` |
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

v1.7 的通知列表按写入顺序从新到旧保留 500 条。`at` 为实际投递到通知中心的 Unix 毫秒时间。按用户本地时间，23:00（含）至次日 08:00（不含）触发的提醒记为 `digest`，其余记为 `now`。已配对的飞书私聊推送新的未读 `now` 通知。读状态和反馈可独立更新，重复提交同一值仍返回 `204`。

v1.5 的记忆接口使用登录会话。网页上的修改和删除由用户直接执行。

`timeline` 返回最近 200 条；更早的用 `GET /api/state?before=<id>` 分页（v1 可不实现）。

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
| `memory` | `MemoryItem[]` | v1.5：工具写入、网页修改或删除、读取触发过期转换后推送全量列表。首次连接与重连后请求 `GET /api/memory` 获取当前列表 |
| `calendar` | `Agenda` | v1.3：日程变化时整体替换。不包含在 `snapshot` 中，重连后前端重新请求 `/api/calendar` |

每 20 秒发一次注释行 `: ping` 保活。前端断线后用 `EventSource` 自动重连，并以收到的 `snapshot` 为准重建状态。

## 错误

除飞书 OAuth 回调的 HTML 错误页外，API 错误响应体为 `{ error: string }`。
