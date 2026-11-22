# Web API 契约（v1）

Web 前端（`packages/web`）与服务端（`packages/server`）之间的接口。服务端只用 Node 内置模块（`node:http`），推送用 SSE。

## 运行

| 变量 | 默认 | 说明 |
|---|---|---|
| `ALTER_WEB_HOST` | `127.0.0.1` | 只监听本机；需要局域网访问时显式改 |
| `ALTER_WEB_PORT` | `4317` | |
| `ALTER_WEB_PASSWORD` | 无（必填） | 单用户登录密码 |

服务端同时托管前端构建产物（`packages/web/dist`），开发时前端用 Vite 代理 `/api`。

## 鉴权

- `POST /api/login` `{ password }` → `204`，设置 `HttpOnly; SameSite=Strict` 的会话 Cookie；失败 `401`
- `POST /api/logout` → `204`
- 其余 `/api/*` 未登录返回 `401`
- 所有写请求要求 `Content-Type: application/json`（挡掉跨站表单提交）

## 数据类型

```ts
type TimelineItem = {
  id: string;                 // 稳定 ID（条目 ID 或提交 ID），前端据此去重
  kind: "user" | "assistant" | "report" | "permission" | "notice";
  text: string;
  at: number;                 // 毫秒时间戳
  taskId?: string;            // report / permission 关联的任务
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
  audience: "main" | "user";  // 只有 user 的请求在网页上可操作
  capability: string;
  tool: string;
  arguments: unknown;         // 解析后的参数
  reason: string;
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
| `GET` | `/api/state` | `{ timeline: TimelineItem[], tasks: Task[], pending: PermissionRequest[], ledger: LedgerEntry[], leases: { capability: string; idleTurns: number; window: number }[], busy: boolean }` |
| `POST` | `/api/messages` | 请求 `{ text }` → `202 { id }`；主会话忙时排队，不报错 |
| `POST` | `/api/permissions/:id` | 请求 `{ allow: boolean, note?: string }` → `204`；非用户受众或已处理 `409` |
| `GET` | `/api/tasks/:taskId/transcript` | `{ items: TranscriptItem[] }` |
| `POST` | `/api/stop` | 停止主会话当前回合 → `204` |
| `GET` | `/api/usage` | `usageSummary()` 的结果数组 |
| `GET` | `/api/events` | SSE，见下 |

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

每 20 秒发一次注释行 `: ping` 保活。前端断线后用 `EventSource` 自动重连，并以收到的 `snapshot` 为准重建状态。

## 错误

非 2xx 响应体为 `{ error: string }`。
