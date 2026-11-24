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
| 审批与审计 | `hook(ToolTask, { beforeTool })`、`defineSignal`、`tx.signal` | Broker 记录工具、动作、等级和裁决。需要审批时保存请求，再让工具调用在自己的信号上休眠。转问用户时等待宿主通过 `answerUserPermission` 答复。 |
| 租约 | 会话 document、`beforeTool`、`afterRun`、`configure` | 日历任一工具被调用都会刷新整个日历租约。轮次按主会话完成的一次 run 计，同一 run 内的多次模型请求合算一轮。连续 30 轮未用后，下一轮请求中移除日历的全部 schema。 |

## 实现中影响设计的细节

- `HookApi` 能读信号和快照，但没有通用的文档写事务。Broker 使用主会话的 `commit`，把待审批记录、挂起审计和发给主会话的通知一起提交。信号允许早于休眠到达。唤醒会重跑整个钩子，用持久化工具任务 ID 区分各次调用，也避免重复通知和审计。
- 只读直接执行。写操作由审批模型对照权限说明判断，不可逆操作询问用户，全权限任务可执行不可逆操作。用户选择单次批准、本任务全权限或拒绝。
- `beforeRequest` 只能改消息。主会话在启用能力时立即改写 `modelTools`，因此同一 run 的下一次模型请求就能使用日历。每轮结束时，由 `afterRun` 的子任务在一笔事务中推进轮次、清理租约并重算工具列表。运行时会等它完成，再处理排队的 follow-up。
- pi 仅在同一批工具调用都要求终止时响应 `control.terminate`。因此 `finish` 须单独调用。`onYield` 遇到普通文字回答时启动持久化检查任务，最多提醒三次。超过次数后通知主会话任务失败，账本只收入通过 `finish` 校验的成功记录。每段工具循环另有 40 轮上限。
- 安装包和本地源码示例有签名差异。例如安装版信号状态使用 `value` 或 `expired` 字段，事务内接纳输入使用 `submit(tx, draft)`。实现以安装包的 dist 类型和实际行为为准。pi-durable 的导入集中在 `src/runtime.ts`。

## 验证与风险边界

- 运行 `pnpm -C packages/core typecheck` 和 `pnpm -C packages/core test`。租约用例检查 faux 模型实际收到的工具增删记录，在最后一次使用后的第 30 轮及其下一轮分别断言边界。上下文用例让 fork 和 fresh 两种任务尝试回忆同一条仅在主会话中出现的事实。
- 崩溃用例在 SQLite 已记录工具休眠后杀掉进程，再由新 Harness 接收审批，验证发件箱执行一次、账本写入一次、主会话收到一次报告。另一个用例在正常关闭后恢复任务，并再次重开数据库检查重复回投。
- 日历、笔记、发件箱随进程重建。SQLite 持久化的是编排状态和记录。测试覆盖在副作用执行前中断；真实连接器在远端已成功、本地尚未记录结果时仍可能处于未知状态，需要远端幂等键或对账。
- M0 的审批入口信任调用它的宿主，尚未接入 ADR-0003 的 Surface 身份验证。审批默认等待 24 小时，CLI 和 Web 可通过 `ALTER_APPROVAL_TIMEOUT_MINUTES` 配置。任务索引、账本与审计保留全部历史，长期运行前需要实测增长并制定归档策略。faux 用例验证流程和可见上下文；真实模型的派单质量、租用收益和对提示注入的抵抗力仍需独立评测。

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

## Issue #9 · 思考强度

- `ALTER_MAIN_THINKING`（默认 `medium`）与 `ALTER_TASK_THINKING`（默认 `high`）经 pi-durable 会话配置的 `thinkingLevel` 生效；网关模型声明 `reasoning: true` 并开启 `supportsReasoningEffort`，pi-ai 走 OpenAI 风格的 `reasoning_effort` 字段。
- 打开旧数据库时，主会话与运行中任务的思考强度随模型配置一起升级。
- **GLM 必须带思考强度**：实测 opencode-go/glm-5.3 的工具调用不带 `reasoning_effort` 时稳定在 97–118 s，带 `medium` 为 3.5 s。不设会撞上首段超时并回退。
- 真网关冒烟（全新数据目录）：读笔记任务 13 s；建日程 + 审批发送 22 s（#1 时为 32 s）。GLM p50 1.8 s，DeepSeek p50 3.4 s，零失败零回退。

## Issue #2 · Web 后端

- 使用仓库固定的 Node 版本运行 `pnpm -C packages/server start`。入口通过 `loadRepoEnv()` 加载配置，打开数据目录的 `main.sqlite`，挂好观察器后调用 `resume()`。默认监听 `127.0.0.1:4317`。可以通过 `ALTER_WEB_HOST` 和 `ALTER_WEB_PORT` 覆盖。缺少 `ALTER_WEB_PASSWORD` 时启动失败。
- 登录对配置密码与提交密码分别计算 SHA-256，以 `timingSafeEqual` 比较定长摘要。每次成功登录生成 32 字节随机令牌，浏览器通过带 `Path=/; HttpOnly; SameSite=Strict` 的会话 Cookie 携带。令牌仅存于当前服务进程，重启后需重新登录。登出立即撤销该令牌，并关闭使用它的 SSE 连接。写接口要求 JSON 媒体类型，接收参数的请求体上限为 1 MiB。
- CLI 和 Web 共用 `observeSurface`。主会话的 `pi.live.generation.message` 由 pi-durable 节流更新，`observeDoc` 可以在进度写入 SQLite 前看到变化。每次只取正文块，组成累计全文。ID 由生成任务 ID 和该次模型请求的起始时间构成。主会话提交 assistant 条目时，通过条目的任务归属和消息时间重建同一 ID。快于首次进度更新的短回答会在最终 `timeline` 前发送一次完整正文的 `delta`。重新连接先发快照，若正在输出正文，紧接着补发当前全文。
- 用户输入在接纳时获得稳定 ID，立即回显。任务报告也在进入收件箱时可见；放入正式会话记录时按提交记录去重。用户审批在快照中带解析后的工具参数，审批事件的时间可从审计记录恢复。网页只能答复用户受众，同一审批的并发答复只有首次成功。停止操作按主会话当前生成任务的 ID 中止，已排队的消息继续处理。
- 新任务在派单事务中保存上下文模式和创建时间。打开旧库时按子会话是否有父分支恢复模式，用任务说明条目的时间近似创建时间；尚未写入说明时以 `0` 表示未知。任务转录按会话顺序读取，fork 会包含继承的历史。租约返回距上次使用的完整轮数，以及与过期规则共用的 30 轮窗口。
- 已实现 v1 的全部必选接口和 SSE 事件。时间线保留最近 200 条，可选的 `before` 分页未实现。离线用例覆盖真实 HTTP、SSE 和 SQLite 恢复；前端构建与真实网关的联调仍需在运行环境验证。

## Issue #12 · 插件契约与 163 邮箱

宿主在 `openAlter(storage, models, mainModel, taskModel, thinking, { plugins })` 的最后一个参数传入插件。每个插件提供 `capability`、`tools`，可选的 `start(host)` 返回异步停止函数。每次打开的实例都从示例能力与本次插件生成注册表。工具名须与清单中的 `能力名_动作名` 一一对应。Broker、派单允许清单和主会话租约都使用当前实例的能力。任务和主会话租约均可使用邮件插件的 11 个工具。主会话可指定 `action: "read"` 只租读取；发信、回复和转发按 write 审批，具体规则见 ADR-0021。

Harness 就绪后启动事件源。插件通过 `await host.emit({ source, kind, summary, ref, at, untrusted: true })` 报告事件，`at` 是 Unix 毫秒时间。宿主将事件写入主会话的 `alter.events` 文档，保留最近 500 条。事件不会触发模型轮次。调用方用 `await app.close()` 等待事件源停止及在途事件写入，再关闭 Harness。

### 配置与取信

`mailConfigFromEnv(env)` 在 `ALTER_MAIL_ADDRESS` 为空时返回 `undefined`，宿主可按下例省略邮件插件。启用时须提供邮箱地址和客户端授权码 `ALTER_MAIL_AUTH_CODE`。`ALTER_MAIL_IMAP` 和 `ALTER_MAIL_SMTP` 使用 `host:port`，默认分别为 `imap.163.com:993` 和 `smtp.163.com:465`。

```ts
const mail = mailConfigFromEnv(process.env);
const plugins = mail ? [createMailPlugin(mail)] : [];
const app = await openAlter(storage, models, mainModel, taskModel, thinking, { plugins });
```

- 每条 IMAP 连接都在握手前设置 ImapFlow 的 `clientInfo`。2.12.2 在服务端声明支持 ID 时发送 RFC 2971 命令，可在认证前发送，也可在认证后补发。内存传输测试检查了线上协议格式，真实账号仍须确认能通过 163 的 Unsafe Login 检查。
- 通过 IMAP 特殊用途标记寻找 Sent 与 Drafts。未提供标记时分别使用“已发送”和“草稿箱”。草稿通过带 `\\Draft` 标记的 APPEND 保存；搜索默认最多返回最新 20 条，可指定 1 至 100 条。
- `mail_read` 按文件夹（默认 INBOX）与 UID 读取信封头和 MIME 结构，优先取纯文本，HTML 通过 mailparser 转成文本。正文最多取 64 KiB 解码数据，输出最多 16,000 个 UTF-16 码元。附件列出序号、名称、类型和大小。用 `mail_attachment` 单独下载。搜索和读取结果逐封加上 `<external source="mail" uid="…">` 边界，转义邮件中的尖括号，并附 `details.untrusted` 与 `details.source` 标明结果来源。
- IDLE 使用独立的只读 INBOX 连接。首次打开以 UIDNEXT 为起点；收到 EXISTS 后按 UID 补取，每封邮件写一条带发件人、主题和 `INBOX/UIDVALIDITY/UID` 引用的事件。断线后按 1 至 60 秒退避，并使用内存中的游标补取。进程重启或 UIDVALIDITY 改变会重新建立起点；这两个间隔中的邮件可用 `mail_search` 查询。

### 发送恢复与风险

`alter.mail-sends` 文档按 pi 工具任务 ID 持久化 Message-ID、发件账号、收件地址、生成时间和发送阶段。回复和转发还记录源文件夹、UID 和发送方式。Message-ID 包含持久化的随机命名空间与工具任务 ID，使独立数据库中的相同数字 ID 也能区分。SMTP 和 IMAP 归档共用 Nodemailer 生成的原始邮件。工具成功后返回 Message-ID，宿主可据此核对。

| 恢复时的证据 | 同一工具任务的行为 |
| --- | --- |
| Sent 按 Message-ID 已找到副本 | 直接返回原 Message-ID。 |
| 尚未尝试 SMTP，且 Sent 查询成功、无匹配 | 先持久化发送意图，再调用 SMTP。 |
| 已持久化 SMTP 接收确认，Sent 仍无副本 | 只补做 IMAP APPEND。 |
| 已记录发送意图，但缺少接收确认且 Sent 无匹配 | 报告投递状态未知并给出 Message-ID，交由用户对账。 |
| 已完成归档，此后用户删除了副本 | 重放仍返回原 Message-ID。 |

SMTP 接收、Sent 归档和本地事务无法原子提交。服务器延迟生成 Sent 副本可能导致同一投递出现两份归档。模型重新发起一次工具调用会获得新的任务 ID，遇到投递状态未知须先核对原 Message-ID。离线恢复测试在模拟 SMTP 接收后、插件取得确认前用 SIGKILL 终止子进程，重开 SQLite 后从模拟 Sent 找回原邮件，验证恢复期间 SMTP 调用数为零。

真机验证由仓库根目录运行 `pnpm -C packages/plugin-mail live`。脚本加载根目录的 `.env`，列邮箱目录，查询最近五封并试读最新一封，存一份草稿，给本账号发送一封测试邮件，按 Message-ID 验证 Sent。出现 IDLE 提示后，在 30 秒内从另一个邮箱寄入一封新邮件，核对事件中的发件人、主题和 UID。脚本产生的草稿和邮件留在账号内供核对。

### ego 浏览器插件（#5）

Web 服务默认注册 `browser`，设置 `ALTER_BROWSER=off` 可关闭。主会话可通过 `enable_tool` 启用它，后台任务也可直接使用。每个会话使用名为 `Alter <conversationId>` 的 ego TaskSpace。`alter.browser-space` 文档保存空间编号和选中的标签页（默认 `p1`）。若空间已被关闭，下次页面操作会重新创建。

- `read` 动作包括 `browser_open`、`browser_snapshot`、`browser_scroll`、`browser_screenshot`、`browser_handoff`、`browser_close` 和 `browser_guide`。
- `write` 动作包括 `browser_click`、`browser_fill`、`browser_press` 和 `browser_run`。多标签、文件传输或页面内 JS 等操作先读 `browser_guide`，再用 `browser_run` 编写脚本。脚本可直接使用 `task` 和 `page`，默认超时 120 秒，可通过 `timeoutMs` 调整至最多 600 秒。

页面快照和错误消息均经过转义，默认保留前 12,000 个字符，带浏览器来源与不可信标记。`browser_close` 返回关闭前的最后一个视口。后台任务结束或中止时，宿主调用插件可选的 `onTaskEnd` 回收空间。进程正常停止时，插件也会尝试关闭仍在使用的空间。真机冒烟入口为 `pnpm -C packages/plugin-browser live`。

## Issue #20 · 内置日历与当前时间

Web 服务默认加载 `@alter/plugin-calendar`。插件启动时打开 `<ALTER_DATA_DIR>/calendar.sqlite`，停止时关闭连接。同名插件整组替换示例能力的清单与工具。CLI 与租约评测沿用仅存标题的内存示例，评测仍可通过 `app.demo.calendar` 预置和检查日程。

- 主会话可用 `enable_tool calendar` 租用日历。查询属于 `read`，创建、更新、软删除和恢复均属于 `write`。日程是用户本地数据。
- 起止时间存为 UTC 毫秒，分别保留传入的偏移或解释时间时使用的时区。工具按 `ALTER_TZ` 返回本地时间、星期和带偏移的 ISO 时间。默认时区为 `Asia/Shanghai`。夏令时回拨出现两个相同钟面时间时默认取较早一次，显式偏移可指定另一次。输入落在向前拨钟跳过的时段时，工具会报错。
- 查询返回与左闭右开区间重叠的日程，按开始时间排序。默认范围从本地今天零点至第七天后的零点。定时日程默认一小时，全天日程以本地日期为单位，结束日期为排他边界。更新只改提供的字段，移动至另一日期时同时传起止时间。新建或更新成功的结果含 `conflicts` 列表，已删除和首尾相接的日程均不计入冲突。
- 用户消息在提交时、任务 brief 在派单时固定时间前缀。模型收到的内容带前缀，条目 `data.text` 保存原文。Web 的排队回显、历史时间线及任务转录读取原文，旧条目回退到已有正文。派单记录也保留原 brief。
