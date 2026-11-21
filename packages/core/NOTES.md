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
