# Alter M0 运行时验证

在 Node 24.21.0 和 pi-durable 1.6.0 上，ADR-0001 的四项验证均已通过。15 个离线 faux 集成用例覆盖后台回投、审批挂起、SQLite 恢复和主会话租约。恢复测试分别使用正常关闭 Harness 和直接向子进程发送 `SIGKILL` 两种方式。

## 概念与 API

| Alter 概念 | pi-durable API | M0 的行为 |
| --- | --- | --- |
| 主会话 | `Harness.root`、`defineExtension`、`configure({ modelTools })` | 根会话起初只向模型提供派单、查询、答复审批和租用能力四个工具。 |
| 能力与动作 | `defineTool`、`createRegistry` | manifest 将每个工具名映射为能力、动作和副作用等级。日历、笔记、发件箱各有独立的内存实现。 |
| 后台任务 | `tx.createTask({ background: true })`、`tx.createConversation`、`tx.forkConversation` | 后台任务拥有子会话。fresh 只给任务说明，fork 在派单事务内用 `latestEntryId` 确定分支点。两种模式都显式配置任务工具。 |
| 任务完成与回投 | `defineDoc`、`ConversationHandle.submit(tx, …)`、`control.terminate` | `finish` 校验摘要与引用，把账本、完成状态和主会话 follow-up 放入同一笔事务。回投使用稳定的请求 ID，重放时不会多生成一条报告。 |
| 等待与恢复 | `SubmissionSettled`、`notify`、`Harness.resume()` | 派单工具立即返回任务 ID。后台任务提交 brief 后休眠，收到子会话结算信号再检查是否成功收尾。重开 SQLite 后，宿主重新安装同名扩展并调用 `resume()` 即可恢复。 |
| 审批与审计 | `hook(ToolTask, { beforeTool })`、`defineSignal`、`tx.signal` | Broker 记录工具、动作、等级和裁决。需要审批时保存请求，再让工具调用在自己的信号上休眠。restricted 通知主会话；auto 的高风险调用等待宿主通过 `answerUserPermission` 答复。 |
| 租约 | 会话 document、`beforeTool`、`afterRun`、`configure` | 日历任一工具被调用都会刷新整个日历租约。轮次按主会话完成的一次 run 计，同一 run 内的多次模型请求合算一轮。连续 30 轮未用后，下一轮请求中移除日历的全部 schema。 |

## 实现中影响设计的细节

- `HookApi` 能读信号和快照，但没有通用的文档写事务。Broker 使用主会话的 `commit`，把待审批记录、挂起审计和发给主会话的通知一起提交。信号允许早于休眠到达。唤醒会重跑整个钩子，用持久化工具任务 ID 区分各次调用，也避免重复通知和审计。
- restricted 下，直接调用未授权工具时，批准只放行那一次。显式调用 `request_capability` 获批后，将能力加入该任务的允许清单。auto 下的每个对外发送都单独问用户。主会话拿到用户审批的请求 ID 也无法代答。
- `beforeRequest` 只能改消息。主会话在启用能力时立即改写 `modelTools`，因此同一 run 的下一次模型请求就能使用日历。每轮结束时，由 `afterRun` 的子任务在一笔事务中推进轮次、清理租约并重算工具列表。运行时会等它完成，再处理排队的 follow-up。
- pi 仅在同一批工具调用都要求终止时响应 `control.terminate`。因此 `finish` 须单独调用。`onYield` 遇到普通文字回答时启动持久化检查任务，最多提醒三次。超过次数后通知主会话任务失败，账本只收入通过 `finish` 校验的成功记录。每段工具循环另有 40 轮上限。
- 安装包和本地源码示例有签名差异。例如安装版信号状态使用 `value` 或 `expired` 字段，事务内接纳输入使用 `submit(tx, draft)`。实现以安装包的 dist 类型和实际行为为准。pi-durable 的导入集中在 `src/runtime.ts`。

## 验证与风险边界

- 运行 `pnpm -C packages/core typecheck` 和 `pnpm -C packages/core test`。租约用例检查 faux 模型实际收到的工具增删记录，在最后一次使用后的第 30 轮及其下一轮分别断言边界。上下文用例让 fork 和 fresh 两种任务尝试回忆同一条仅在主会话中出现的事实。
- 崩溃用例在 SQLite 已记录工具休眠后杀掉进程，再由新 Harness 接收审批，验证发件箱执行一次、账本写入一次、主会话收到一次报告。另一个用例在正常关闭后恢复任务，并再次重开数据库检查重复回投。
- 日历、笔记、发件箱随进程重建。SQLite 持久化的是编排状态和记录。测试覆盖在副作用执行前中断；真实连接器在远端已成功、本地尚未记录结果时仍可能处于未知状态，需要远端幂等键或对账。
- M0 的审批入口信任调用它的宿主，尚未接入 ADR-0003 的 Surface 身份验证。审批没有超时，未收到答复会持续等待。任务索引、账本与审计保留全部历史，长期运行前需要实测增长并制定归档策略。faux 用例验证流程和可见上下文；真实模型的派单质量、租用收益和对提示注入的抵抗力仍需独立评测。

## Issue #1 · 真实网关、回退链与终端入口

### 一次模型请求如何回退

在 pi-ai 的 `ProviderStreams.stream` 和 `streamSimple` 外包一层，两者共用同一段回退逻辑，下面仍由 pi 的 `openai-completions` 处理 SSE、工具参数分片和用量。pi-durable 的 `beforeRequest` 看不到流事件，`afterResponse` 收到的是最终消息。在 provider 层可以对同一份消息和工具定义换模型，也可以在第一段实际输出到达时立即转发。

同一网关按会话角色注册为 `alter-main` 和 `alter-task`。SQLite 保存稳定的 `chain` 引用，所以更换环境变量中的首选模型后，已有会话可以使用新顺序。各角色也注册了链内的实际模型 ID，发给网关时完整保留斜杠。fresh 和 fork 子会话都显式配置任务模型。打开旧库时只更新主会话指令、主模型和运行中子会话的模型配置，原有工具租约和待审批记录继续有效。

- 每次请求从本角色的首选模型开始。HTTP 5xx、429、401/403、网络中断或首段输出超时会依次尝试下一项。普通 HTTP 400、调用方取消或整条链用尽时结束请求。
- pi 的 `start` 只表示收到响应头。角色帧、SSE 心跳都不会解除首段输出超时。正文、思考内容或工具调用开始后清除定时器，此后断线保留该模型的部分回答和错误。已输出的工具参数不会拼接到下一个模型。pi-ai 和 pi-durable 的额外重试均已关闭。
- 实际胜出的网关模型 ID 写入 assistant 消息的 `model`。若网关还报告了不同的后端模型，pi 可另存为 `responseModel`。

### 启动和使用

使用仓库固定的 Node 24.21.0，在仓库根目录运行：

```sh
eval "$(fnm env)" && fnm use
pnpm -C packages/core chat
pnpm -C packages/core usage
```

两个命令均通过 Node 内置的 `process.loadEnvFile` 加载仓库根目录的 `.env`，也支持直接设置环境变量。变量示例见根目录的 `.env.example`。

| 变量 | 取值 |
| --- | --- |
| `ALTER_LLM_BASE_URL`、`ALTER_LLM_API_KEY` | Chat Completions 网关的 API 基址和密钥，例如 `https://gateway.example/v1`。只有主机名时自动补上 `/v1`。 |
| `ALTER_MAIN_MODEL`、`ALTER_TASK_MODEL` | 各自按优先级排列的完整网关 ID，用逗号分隔，例如 `wbcn/glm-5.3,qwenwork/glm-5.3`。 |
| `ALTER_FIRST_TOKEN_TIMEOUT_MS` | 各次尝试独立计时，默认 60000 毫秒。 |
| `ALTER_DATA_DIR` | 默认仓库根目录下的 `data/`，相对路径也按仓库根目录解析。会话存在 `main.sqlite`，模型用量存在 `usage.jsonl`。 |

CLI 会先订阅主会话和审批记录，再调用 `resume()`。输入一行即可开始对话。后台报告即使排在主会话队列里也会立即显示。重启后，仍待用户决定的请求会重新显示请求 ID、工具、参数和原因。`/approve <id> [备注]` 与 `/deny <id> [备注]` 只答复用户受众的审批；`/tasks` 查看任务状态，`/quit` 关闭会话宿主。真人冒烟可以先要求“派一个受限任务读取 welcome 笔记，允许使用 notes”，再要求“派一个 auto 任务用 outbox 发送你好”，分别验证回投和审批。

### 用量日志

每次模型尝试结束时追加一行 JSON，包括失败的首选模型与后续备用模型。例如一次 HTTP 429 后成功：

```jsonl
{"at":"2026-11-22T00:00:00.000Z","conversation":"main","model":"wbcn/glm-5.3","attempt":1,"outcome":"error","errorKind":"rate_limit","latencyMs":102}
{"at":"2026-11-22T00:00:00.103Z","conversation":"main","model":"qwenwork/glm-5.3","attempt":2,"fallbackFrom":"wbcn/glm-5.3","outcome":"ok","latencyMs":980,"firstTokenMs":210,"inputTokens":120,"outputTokens":32}
```

`at` 是该次尝试开始的 UTC 时间，`conversation` 为 `main` 或 `task`。`attempt` 对每次新请求从 1 开始，`fallbackFrom` 指前一项。`latencyMs` 和 `firstTokenMs` 都相对本次尝试的开始计时。只有看到了输出才有 `firstTokenMs`，只有网关返回用量才记录 token，输入计数包含缓存。`errorKind` 可为 `timeout`、`server`、`rate_limit`、`auth`、`network`、`http`、`provider` 或 `aborted`。日志字段只包含调用元数据。

`usage` 按模型聚合所有角色的尝试。calls 包含失败与中止，failureRate 是供应商失败次数占比（用户主动中止单独计入 aborted，不算失败），fallbacks 是作为备用模型被调用的次数。p50 和 p95 采用最近秩，计算所有尝试的延迟，单位为毫秒。token 列只累加已报告的用量。

### 真网关冒烟（2026-11-22）

主链 `opencode-go/glm-5.3`，任务链 `opencode-go/deepseek-v4.1-flash`，各带 4 个备用：

| 场景 | 结果 | 耗时 |
| --- | --- | --- |
| 主会话派受限任务读取 welcome 笔记并转述 | 通过，报告回投、主会话转述正确 | 11 s |
| auto 任务建日程后发送邀请 | 日程直接执行；发送挂起等待用户；`/approve` 后完成 | 32 s（含审批） |

12 次模型调用全部由首选模型完成，未触发回退；网关支持流式工具调用并返回用量。唯一一条 error 是脚本退出时中止的在途请求，据此把 aborted 从失败率中拆出。

### 验证与开放风险

- 离线测试通过本地 HTTP 服务验证各类错误、首段超时、输出后断流、流式工具调用、两种任务上下文、排队回投、SQLite 恢复和用量统计。真网关仍需确认完整模型 ID、流式工具调用和 `stream_options.include_usage` 支持情况。内置模型元数据暂用 65,536 上下文和 4,096 输出上限，价格字段为零；实际限制与账单以网关为准。
- 首段输出超时会取消本地 HTTP 尝试，网关仍可能已经接单计费。同一个不可用或无效的密钥也可能使整条链返回鉴权失败。首段之后不再启用这一定时器。
- SQLite 与用量文件分别落盘。进程被强杀时，未结束的调用可能缺少日志；JSONL 适合排障与汇总，精确计费仍需网关对账。关闭运行时自动重试后，进程若在模型请求进行中退出，恢复时该轮可能标记为 interrupted。已经挂起等待审批的任务可继续。
