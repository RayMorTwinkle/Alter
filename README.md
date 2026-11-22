# Alter

一个主动的个人智能体：它能派遣子代理完成任务、主动发现该做的事、代表你收发消息，并记得你的上下文。

> 状态：v0.1.0（M1 可用）。名称为暂定代号。

已经能做的：网页上和主会话对话，它派子代理去读写日程、收发 163 邮件、操作 ego 浏览器；对外发送一律先给你审批，读过外部内容的任务受污点规则约束，审批 24 小时无人处理自动拒绝。

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

## 评测

- [工具租约 vs 全派任务](docs/adr/0002-main-session-control-plane-and-leases.md#验证结果2026-11-226)：同样 100% 正确，租约 token 约 1/3、延迟约一半（`pnpm -C packages/core eval:lease`）

## 文档

- [架构总览](docs/architecture/overview.md)
- [架构决策记录（ADR）](docs/adr/)
- [路线图](docs/roadmap.md)
- [协作规范](CONTRIBUTING.md)

## 许可

MIT
