# Alter

一个主动的个人智能体：它能派遣子代理完成任务、主动发现该做的事、代表你收发消息，并记得你的上下文。

> 状态：v0.4.0（M6 少打扰与可观测）。名称为暂定代号。

已经能做的：
- 网页或飞书机器人和主会话对话，它派子代理去读写日程、收发 163 邮件、操作 ego 浏览器、读写你的飞书消息
- 记得你的偏好和目标；能定时提醒；每天按目标做只读调研
- 新邮件和飞书消息先分诊（立即 / 摘要 / 静默），只有急事推送，其余进 21:00 每日摘要；安静时段不打扰
- 只读工具直接执行。写操作由审批模型核对任务的权限说明，主会话使用用户最近的原话。超出范围、关闭审批模型或执行不可逆操作时询问用户。用户可选「允许这一次」「本任务全权限」或「拒绝」。全权限任务可执行不可逆操作。
- 主会话按间隔自己巡检（2–48 小时，按你的采纳情况调整），决定是否告诉你；支持定时任务和盯梢任务
- 订阅 RSS、GitHub 通知或任意 JSON 接口作为消息来源
- Web 上有统计页、巡检记录、设置页（插件、密钥、审批模式），不必编辑 .env

## 核心设计

- **主会话只指挥，不动手**：用户只和主会话对话；主会话通过派遣任务（子代理）间接使用工具，只有日程这类高频工具可以临时"租用"。→ [ADR-0002](docs/adr/0002-main-session-control-plane-and-leases.md)
- **指令和数据分开**：你通过飞书和 Alter 说话是指令；Alter 用你的飞书账号收到的消息只是数据，永远不会被当作指令执行。→ [ADR-0003](docs/adr/0003-surface-vs-connector.md)
- **按副作用授权**：不管能力来自工具、MCP、技能 CLI 还是 API，都按"读 / 本地写 / 对外发送 / 不可逆"分级授权。→ [ADR-0004](docs/adr/0004-capabilities-and-permission-tiers.md)
- **持久化运行时**：基于 [pi-durable](https://github.com/earendil-works/pi)，任务可以跑很久、等待审批、在重启后继续。→ [ADR-0001](docs/adr/0001-build-on-pi-durable.md)

## 快速开始

需要 Node 24 与 pnpm 11。

```sh
pnpm install
cp .env.example .env        # 填网关、模型、ALTER_WEB_PASSWORD；邮箱可选
pnpm -C packages/web build
pnpm -C packages/server start   # http://127.0.0.1:4317
```

| 包 | 作用 |
|---|---|
| `packages/core` | 主会话、任务、权限（broker）、租约、账本、模型回退链；`pnpm -C packages/core chat` 是终端入口 |
| `packages/server` | Web API（REST + SSE），托管前端 |
| `packages/web` | 对话界面（React） |
| `packages/plugin-mail` | 163 邮箱连接器 |
| `packages/plugin-browser` | ego 浏览器连接器 |
| `packages/plugin-calendar` | 本地日程 |
| `packages/plugin-feishu` | 飞书机器人 Surface + 用户账号连接器 |
| `packages/evals` | 端到端、提示注入、分诊评测 |

## 评测

- [端到端任务](docs/evals/2026-11-22-e2e.md)：33/33（`pnpm eval:e2e`）
- [提示注入](docs/evals/2026-11-22-injection.md)：10 类攻击成功 0 次，另有模型无关的正对照回归测试（`pnpm eval:injection`）
- [分诊](docs/evals/2026-11-22-triage.md)：准确率 91.7%，急事召回 100%（`pnpm eval:triage`）
- [主模型对比](docs/evals/2026-11-22-main-model-sol.md)：GLM 与 gpt-6.2-sol 同样全过，GLM 更快更省
- [工具租约 vs 全派任务](docs/adr/0002-main-session-control-plane-and-leases.md#验证结果2026-11-226)：同样 100% 正确，租约 token 约 1/3、延迟约一半（`pnpm -C packages/core eval:lease`）

## 文档

- [架构总览](docs/architecture/overview.md)
- [架构决策记录（ADR）](docs/adr/)
- [路线图](docs/roadmap.md)
- [协作规范](CONTRIBUTING.md)

## 许可

MIT
