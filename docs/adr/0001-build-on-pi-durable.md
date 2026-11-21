# ADR-0001 以 pi-durable 作为 Agent 运行时底座

- 状态：已接受
- 日期：2026-11-22

## 背景

Alter 需要：一个长期在线的主会话；主会话派出的子代理（任务）要能跑很久、能等人审批、能在进程重启后继续；主动功能需要定时唤醒。自己从零写 agent loop 加上这些能力，工作量大且容易出错。

候选底座是 [earendil-works/pi](https://github.com/earendil-works/pi)（原 pi-mono，v1.6.0，MIT）。调研后发现它的 `pi-durable` 包几乎覆盖了我们的核心需求：

| Alter 需求 | pi-durable 提供 |
|---|---|
| 主会话派任务、任务结果回到主会话 | 任务拥有的子会话（subagent），后台子代理的答案以 follow-up 回投（示例 22） |
| 带 / 不带主会话上下文 | `fork(entryId)` / 新建会话 |
| 受限权限、向主会话申请工具 | `beforeTool` 钩子可阻止调用，或挂起等待信号（示例 44 审批闸门） |
| 主会话租用工具 | 每个会话独立的 `modelTools` 配置 |
| 能力目录，按需加载工具 | `deferred` 工具 + `tool_search` |
| 主动功能的定时唤醒 | 持久化的 `sleepUntil` 与信号 |
| 重启不丢任务 | 所有状态先提交再展示，SQLite 存储，`resume()` |
| 可观测性 | `pi-telemetry` 的类型化 span 与指标 |
| MCP | `pi-mcp` |

## 决策

以 `@earendil-works/pi-durable` + `pi-ai` + `pi-mcp` 为运行时底座，**锁定精确版本**（当前 1.6.0），升级走单独的 PR 并跑完整评测。

Alter 自己的概念（Capability、权限档位、Surface/Connector、记忆）全部实现为 pi-durable 的 extension，不修改 pi 源码。

## 备选方案

- **pi-agent-core（底层 agent loop）自己搭**：更可控，但持久化、任务树、挂起审批都要自己写。保留为后备方案。
- **pi-coding-agent 的扩展系统**：面向终端编码代理，形态不符。
- **其他框架（LangGraph 等）**：Python 生态，和跨平台 Node 技术栈及 pi 生态不一致。

## 后果

- 好处：核心难题（持久化、任务树、审批挂起）由成熟实现承担，我们专注产品层。
- 代价：pi-durable 标注为 **Experimental**，API 会在版本间变化。对策：锁版本；Alter 代码通过一层薄适配（`packages/runtime`）访问 pi-durable，变更时只改这一层。
- 要求 Node ≥ 22.19，仓库用 `.node-version` 固定为 24.x。

## 如何验证

M0 原型必须用 pi-durable 跑通四件事，任何一件跑不通就回退到 pi-agent-core：

1. 主会话只有控制面工具，派出的后台任务完成后答案回投主会话；
2. 受限任务调用未授权工具时被 `beforeTool` 挂起，主会话批准后继续；
3. 进程在任务执行中被杀掉，重开后任务继续；
4. 主会话租用一个工具后可直接调用，租约过期后工具从 `modelTools` 消失。

## 验证结果（2026-11-22，M0 原型）

四项全部通过，另加三项（账本强制、auto 档、fork/fresh 上下文差异），共 15 个离线测试，1.8 秒跑完：

| 验证项 | 结果 | 测试 |
|---|---|---|
| 后台任务答案回投主会话 | 通过 | `dispatches a fresh notes task…` |
| 受限任务被挂起、主会话批准后继续 / 拒绝后阻止 | 通过 | `permission` 相关用例 |
| 进程中途被杀（含 `SIGKILL`）后恢复，副作用、账本、回投各恰好一次 | 通过 | `resumes a SQLite approval…`、`recovers a parked call after SIGKILL…` |
| 租约 30 轮滑动窗口，不可租能力被拒绝 | 通过 | `renews the calendar lease…` |

额外确认的安全性质：auto 档的对外发送只能由用户批准，主会话无法代答。

实现细节与发现的 pi-durable 限制见 [`packages/core/NOTES.md`](../../packages/core/NOTES.md)。结论：**pi-durable 撑得起 Alter 的核心架构，不需要回退到 pi-agent-core。**
