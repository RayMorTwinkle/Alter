# Alter

一个主动的个人智能体：它能派遣子代理完成任务、主动发现该做的事、代表你收发消息，并记得你的上下文。

> 状态：设计阶段（M0）。名称为暂定代号。

## 核心设计

- **主会话只指挥，不动手**：用户只和主会话对话；主会话通过派遣任务（子代理）间接使用工具，只有日程这类高频工具可以临时"租用"。→ [ADR-0002](docs/adr/0002-main-session-control-plane-and-leases.md)
- **指令和数据分开**：你通过飞书和 Alter 说话是指令；Alter 用你的飞书账号收到的消息只是数据，永远不会被当作指令执行。→ [ADR-0003](docs/adr/0003-surface-vs-connector.md)
- **按副作用授权**：不管能力来自工具、MCP、技能 CLI 还是 API，都按"读 / 本地写 / 对外发送 / 不可逆"分级授权。→ [ADR-0004](docs/adr/0004-capabilities-and-permission-tiers.md)
- **持久化运行时**：基于 [pi-durable](https://github.com/earendil-works/pi)，任务可以跑很久、等待审批、在重启后继续。→ [ADR-0001](docs/adr/0001-build-on-pi-durable.md)

## 文档

- [架构总览](docs/architecture/overview.md)
- [架构决策记录（ADR）](docs/adr/)
- [路线图](docs/roadmap.md)

## 许可

MIT
