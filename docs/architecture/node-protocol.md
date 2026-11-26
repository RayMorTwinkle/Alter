# 节点协议（v1）

类型定义：`packages/node-protocol/src/index.ts`（唯一权威）。决策背景：ADR-0026。

## 角色

- **hub**：某个用户自己的 Alter 实例（大脑）。管理员的 hub 是正式实例；其他用户的 hub 由网关拉起。
- **节点（node）**：用户电脑上的 `packages/node` 进程。一个用户可以有多个节点（宿舍台式、笔记本）。
- **网关**：对外入口。节点连接经网关按 token 中的 `userId` 转发到该用户的 hub。

## 配对与连接

1. 用户在网页「设置 → 我的电脑」点「添加电脑」，hub 生成节点 token `<userId>.<secret>`（只显示一次，hub 只存 secret 的哈希）并给出安装命令。
2. 节点首次运行 `alter-node pair --server https://<域名> --token <token> --name <电脑名>`，把配置写入用户配置目录（macOS `~/Library/Application Support/alter-node/`，Windows `%APPDATA%\alter-node\`，Linux `~/.config/alter-node/`），并生成稳定的 `nodeId`（UUID）。
3. `alter-node run` 打开 `wss://<域名>/api/node/connect`，请求头 `Authorization: Bearer <token>`。网关按 `userId` 转发（含 WebSocket upgrade）；hub 校验 secret，失败回 `rejected` 并关闭。
4. 节点发 `hello`（协议版本、名称、平台、可用代理、允许的工作目录、未对账的任务）；hub 回 `welcome`（含各任务已确认的 `ackSeq`）。
5. 心跳：hub 每 20 秒 `ping`，节点回 `pong`；60 秒无消息视为离线。节点断线后指数退避重连（1 秒起，上限 60 秒）。

## 任务

- hub 发 `task.start`。节点检查代理可用、`cwd` 在 `roots` 内（未给 `cwd` 时用第一个 root），否则立即回 `task.end{status:"failed"}`。
- 运行中节点发 `task.event`（文本、思考、工具调用、工具结果、状态）。每个任务内 `seq` 从 1 递增，覆盖该任务的所有节点消息（event、approval.request、task.end）。
- hub 对收到的消息回 `ack{taskId, seq}`。节点把未确认的消息存在本地（配置目录下 `outbox/<taskId>.jsonl`），重连后按 `welcome.ackSeq` 补发。hub 按 `seq` 去重，因此重发安全。
- `task.message`：任务运行中补充要求（Claude 用流式输入追加用户消息；Codex 用 `turn/steer` 或下一轮 `turn/start`；ACP 代理在本轮结束后再发一次 `session/prompt`）。
- `task.stop`：中断（Claude `interrupt()`；Codex `turn/interrupt`；ACP `session/cancel`），之后必须发 `task.end{status:"interrupted"}`。
- `resume`：`continue_from` 时 hub 带上次 `task.end.nativeSessionId`，节点用代理的原生会话续接（Claude `resume`；Codex `thread/resume`；ACP `session/resume` 或 `session/load`）。

### 报告（一定产生）

1. 节点通过 MCP（本地 stdio 服务器，节点自己实现）向代理暴露 `finish({summary, refs})`。代理调用时记下报告，`reportSource: "finish"`。
2. 代理一轮结束但没调用 `finish`：取本轮最后一条非空助手正文，`reportSource: "last_message"`。
3. 失败、中断、代理进程退出、超时：`status` 为 `failed` / `interrupted`，报告写明原因并附最后的输出，`reportSource: "failure"`。
4. 一个任务默认只跑一轮；`task.message` 触发的后续轮次结束后再发一次 `task.end` 不允许——节点只在任务真正结束时发一次 `task.end`。任务内多轮时，以最后一轮为准。

## 已有会话

用户在代理自己的界面（opencode TUI、dsh 网页、Claude Code、Codex）里已有的对话，Alter 可以列出并接着做，用户回到原界面能看到 Alter 续写的内容。

- `hello.harnesses[].sessions` 为 true 表示节点能列出并续接该代理的会话。
- hub 发 `sessions.list{requestId, harness, cwd?, limit?}`，节点回 `sessions.result`（新到旧，含标题与更新时间；失败给 `error`）。不进 seq/ack，断线由 hub 超时重问。只列 roots 内的会话。
- 续接：`task.start.resume` 填该会话的 `sessionId`。ACP 代理用 `session/resume`（或 `session/load`），Claude 用 `resume`，Codex 用 `thread/resume`。会话正被原界面占用（如 dsh 的会话锁）时，任务以 `failed` 结束并写明原因。

## 审批

- 代理请求权限时，节点发 `approval.request`（原生工具名、参数、按工具推断的 `effect`、一句人话摘要），挂起代理等待。
- hub 交给 broker（审批模型、四档按钮、始终允许等，与内置任务一致），回 `approval.answer`。`deny` 时节点拒绝该操作并把 `note` 告诉代理。
- 节点断线期间挂起的审批：重连后重发；hub 端审批超时按现有规则处理。
- 权限档位映射（节点按此配置代理）：

| Alter | Claude Code | Codex | ACP（dsh、opencode） |
|---|---|---|---|
| restricted | `permissionMode: "default"`，所有工具经 `canUseTool` | `approvalPolicy: "untrusted"`，sandbox `read-only` | 每个 `session/request_permission` 都问 |
| auto | `permissionMode: "acceptEdits"`，命令经 `canUseTool` | `approvalPolicy: "on-request"`，sandbox `workspace-write` | read/edit 类自动允许一次，其余问 |
| full | `permissionMode: "bypassPermissions"` | `approvalPolicy: "never"`，sandbox `workspace-write` | 全部自动允许一次 |

## 主会话视角

- 主会话能力列表里出现「我的电脑」：每个节点的名称、在线状态、可用代理。
- `dispatch_task` 增加可选 `runner: { node: <节点名或 id>, harness: "claude-code" | "codex" | "opencode" | "dsh", session?: <已有会话 id> }`，可选 `cwd`。主会话用 `node_sessions` 工具列出某代理的已有会话。不填 `runner` 时照旧用内置任务。
- 节点离线：任务状态为 `queued`，主会话收到"已排队，电脑上线后开始"；节点 `hello` 后 hub 按派发顺序发 `task.start`。
- 节点事件写进任务记录，网页任务详情与内置任务一样显示；`task.end` 照常形成任务报告唤醒主会话。

## 节点转接器（#172，协议 1 扩展）

支持此功能的节点在 `hello.adapters` 中发送完整摘要数组，空数组也表示支持。支持它的 hub 在 `welcome` 返回 `adapterRpc: true`。节点收到确认后补发当前快照，覆盖握手期间完成的发现。旧节点可省略该字段，旧 hub 仍能接收 hello 并继续派发代理任务。远程转接器要求 WSS，本地回环地址也可用 WS。

| 方向 | 消息 | 语义 |
|---|---|---|
| 节点 → hub | `adapters.state {adapters}` | 完整替换在线快照。工具发现异步进行，状态为 off、connecting、ok 或 error。 |
| hub → 节点 | `tool.call {callId, adapterId, toolName, args, expectedEffect?}` | 使用节点本地的转接器 ID 和工具名。Brain 携带 Broker 所见的效果，节点拒绝效果已变更的调用。 |
| 节点 → hub | `tool.result {callId, ok, content?, isError?, error?}` | content 为脱敏后的文本。成功完成传输的工具仍可返回 isError。 |
| hub → 节点 | `tool.cancel {callId}` | 中止当前连接上的调用。节点也会在 WS 断开或本地截止时间到时中止。 |
| hub → 节点 | `adapters.manage {requestId, action, adapterId?, presetId?, payload?}` | action 支持 list、presets、create、preset.create、patch、refresh、remove。创建与补丁采用 Web API 的请求体。 |
| 节点 → hub | `adapters.manage.result {requestId, ok, data?, error?, status?}` | list 返回摘要数组，presets 返回目录，创建、修改、刷新返回摘要，删除返回 null。失败可附 HTTP 状态码。 |

转接器摘要含 `id, name, kind, capabilityId, enabled, state, detail?, tools, effects`。每个工具含 `name, description, effect, defaultEffect, inputSchema?`。配置、密钥和运行参数留在节点。hub 用配对记录 ID 派生实例内的 capabilityId；网页以 hub 返回的值为准。只有 enabled 且 state 为 ok 的工具才注册。注册沿用普通插件入口，主会话租约、任务工具、Broker 的只读放行、写操作审批和始终允许授权均沿用现有规则。

以上 RPC 按当前认证连接关联，不进入任务日志、seq 或 ack。hub 等待最多 120 秒，断线、撤销或替换连接时立即结束等待。管理超时也可能已经保存配置，重连后先查询摘要。节点默认保存 `adapters.json`、AES-256-GCM 加密的 `adapter-secrets.json` 与随机本机密钥 `adapter.key`，POSIX 权限为 0600。

### 本机管理

`alter-node adapter presets` 列出预设。`adapter add` 从标准输入或 `--file FILE` 读取 JSON，适用于所有三种转接器和两种 MCP 传输。以下示例保存一个包装本机 Git 的 CLI 转接器。

```sh
echo '{"id":"git","name":"Git","kind":"cli","config":{"command":"git","help":"Run git with an argv array"}}' | alter-node adapter add
echo '{"auth":"gh","variant":"readonly"}' | alter-node adapter add --preset github
alter-node adapter list
alter-node adapter effect git run irreversible
alter-node adapter disable git
alter-node adapter enable git
alter-node adapter refresh git
alter-node adapter remove git
```

所有子命令接受 `--dir DIR`。运行中的守护进程通过私有本地套接字处理命令。守护进程停止时，CLI 获取同一写锁保存更改，下次启动自动加载。离线 list 展示已保存的工具，启用项的 connecting 状态表示尚未在当前进程建立连接。
