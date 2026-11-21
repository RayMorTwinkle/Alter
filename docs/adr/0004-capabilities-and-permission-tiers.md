# ADR-0004 统一 Capability 清单，按副作用分级授权

- 状态：已接受
- 日期：2026-11-22

## 背景

Alter 的能力来源五花八门：内置工具、MCP server、技能（skill）里附带的 CLI、直接调用的 HTTP API。如果按来源分别管理权限，每接入一种新来源就要重新设计一遍，而且技能里的 CLI 最终都是"跑一条 shell 命令"，权限系统根本看不出它在做什么。

## 决策

**权限挂在动作的副作用上，而不是传输方式上。**所有能力归一成一份 Capability 清单：

```yaml
id: email
transport: mcp | tool | skill-cli | api   # 只是实现细节
main_leasable: false
actions:
  - name: search   effect: read
  - name: draft    effect: write-local
  - name: send     effect: external-send
  - name: delete   effect: irreversible
secrets: [IMAP_PASSWORD]                  # 由 Broker 注入，模型不可见
cli_patterns:                             # skill-cli 专用
  - "himalaya envelope list *"  -> search
  - "himalaya message send *"   -> send
```

副作用分五级：`read` < `write-local` < `external-send` < `irreversible`，另有 `unknown`（视同最高）。

### 三档任务权限

| 档位 | 行为 |
|---|---|
| **受限 restricted** | 只能用主会话给的允许清单；需要其他能力时调用 `request_capability(cap, reason)`，主会话判断，判断不了再问用户 |
| **自动 auto** | `read`/`write-local` 直接放行；更高等级交给审批模型判断；`external-send` 与 `irreversible` 一律问用户 |
| **全权 full** | 全部放行，但照常审计 |

### CLI 的归属

- 技能里的 CLI 统一经 `cap run <capability> <args>` 包装执行，权限判断、审计、密钥注入集中在一点。
- 裸 `bash` 本身是一个能力（`effect: unknown`）。受限模式下命令先与所有清单的 `cli_patterns` 匹配，命中则按对应能力的对应动作判断，未命中视为申请 shell 权限。
- 接入 MCP server 时自动生成清单草稿，副作用默认填最高级，由开发者手动调低（默认安全）。

## 备选方案

- **按工具名白名单**：无法覆盖 shell 与技能 CLI。
- **全部交给审批模型**：成本高，且审批模型本身可被注入。

## 后果

- 插件开发者必须为每个动作声明副作用，这是插件 SDK 的强制字段。
- 实现上由一个 `beforeTool` 钩子（Capability Broker）统一执行，见 ADR-0001。

## 如何验证

**权限决策准确率**：构造一组带标注的调用（该放行 / 该问用户 / 该拒绝），统计 Broker 的精确率与召回率。重点盯两个错误：该问而没问（漏报，安全问题）和不该问却问了（误报，打扰用户）。
