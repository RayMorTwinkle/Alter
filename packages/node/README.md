# Alter 节点

在运行编码代理的电脑上启动 `alter-node`。节点主动连接自己的 Alter hub，使用这台电脑上已经登录的代理，在授权的工作目录里接收任务。前台运行时请保持终端打开，也可以设置登录自启。

## 安装和配对

使用 Node.js 24 和 pnpm 11.3.0。在 Alter 仓库根目录安装依赖，再把当前检出的节点命令链接到 npm 的全局命令目录。保留这个仓库目录，并确认 npm 的全局命令目录在 PATH 中。

```sh
pnpm install --frozen-lockfile
npm install --global --offline --ignore-scripts ./packages/node
alter-node --help
```

在网页「设置 → 我的电脑 → 添加电脑」取得网关地址和配对 token，然后在节点电脑上运行。跨网络连接请使用 HTTPS。下例中的名称和目录可自行替换，Windows 目录可写成 `--root "D:\代码"`。

```sh
alter-node pair --server https://alter.example.org --token "<userId>.<secret>" --name "宿舍电脑" --root "/Users/me/代码"
alter-node run
```

配对命令保存配置，首次运行生成 UUID，连接时由 hub 校验 token。同一用户和网关可重新配对以更新 token，节点 ID 保持稳定。运行中的节点在下次连接时读取新凭据。配对 token 是密钥，请留意终端历史记录。

在另一终端查看状态或管理目录。

```sh
alter-node status
alter-node roots list
alter-node roots add "/Users/me/第二个项目"
alter-node roots remove "/Users/me/第二个项目"
```

`--root` 可重复。任务省略 cwd 时取第一个 root，未授权任何目录时拒绝启动任务。节点检查目录的真实路径，包含符号链接和 Windows junction。目录修改对下一项任务生效，下次连接时更新 hub 上的目录列表。roots 限制任务的起始目录，代理能访问的文件还取决于原生沙箱、工具权限和操作系统账户。

## 登录自启

配对后运行 `alter-node install-service`，下次登录时启动节点。运行 `alter-node uninstall-service` 可取消后续登录自启。节点自启使用安装时的 Node 和 CLI 绝对路径，移动仓库或切换 Node 安装位置后请重新执行安装命令。

| 平台 | 当前用户的登录配置 |
| --- | --- |
| Windows | 任务计划程序中的 `Alter Node <当前用户 SID>`，以该用户的交互令牌运行。代理目录需在登录环境的 PATH 中。 |
| macOS | `~/Library/LaunchAgents/org.alter.node.plist`，由 launchd 在图形登录时加载。 |
| Linux | `$XDG_CONFIG_HOME/systemd/user/alter-node.service`，默认在 `~/.config` 下，通过 `systemctl --user enable` 启用。 |

macOS 和 Linux 会把安装时 PATH 中的绝对目录写入登录配置。登录后可用 `alter-node status` 查看连接状态。

## 代理和审批

启动时在 PATH 中查找 `claude`、`codex` 和 `opencode`，运行 `--version` 探测版本。请先在电脑上安装并登录所需的代理。

| 任务档位 | Claude Code（Agent SDK） | Codex（app-server） |
| --- | --- | --- |
| restricted | default，转发 canUseTool 审批 | untrusted，read-only |
| auto | acceptEdits，原生规则可直接允许编辑 | on-request，workspace-write |
| full | bypassPermissions | never，workspace-write |

Claude 使用官方 SDK 0.3.263 驱动 PATH 中的可执行文件。Codex 使用 stdio 上的 app-server v2，处理命令执行和文件修改审批。hub 收到的是代理实际发出的权限请求。原生规则已经放行的操作可能没有审批卡片。授权范围由 hub 记忆，节点只放行当前请求。拒绝时，Claude 收到拒绝理由，Codex 通过当前轮的 steer 收到附注。

同一任务的补充消息按到达顺序排队。Claude 在同一流式 query 上输入下一轮，Codex 在同一 thread 上启动下一轮。续接旧任务使用上次报告的原生 session/thread ID。每个任务只结算一次，取最后一轮的 `finish({summary, refs})`，其次取本轮最后的非空助手正文。两者均为空时报告失败。中断、崩溃或超时优先报告原因及已有输出。单个任务的总时限为 4 小时，包含审批等待时间。

opencode 目前只探测版本，并向 hub 上报 `available: false`。参考客户端与本机 2.0.32 的 HTTP 路由、SSE 事件和审批载荷尚未完成兼容验证。

## 断线、退出与本地文件

| 平台 | 配置目录 |
| --- | --- |
| macOS | `~/Library/Application Support/alter-node/` |
| Windows | `%APPDATA%\alter-node\` |
| Linux | `~/.config/alter-node/` |

`config.json` 含 token。macOS / Linux 使用 0600。Windows 在写入 token 前，使用当前用户的 SID 和 icacls 收紧临时文件 ACL，再原子替换配置。每个配置目录同时运行一个节点。

节点响应 hub 心跳，60 秒无消息即断线，重连间隔从 1 秒指数增长到 60 秒。任务可以继续在本机运行，等待审批的调用保持挂起。任务消息先写入 `outbox/*.jsonl`，重连按 hub 的 `welcome.ackSeq` 补发。尚待答复的审批会带原来的 requestId 和 seq 重发，hub 需要按任务和 seq 去重。收到终态确认后删除日志，保留小型 `.done` 文件防止重复派发。

Ctrl+C 或 SIGTERM 会停止活跃任务并保存中断报告。POSIX 平台结束代理进程组，Windows 使用 `taskkill /T /F`。如果操作系统强杀节点，恢复时对未结算的任务报告「执行结果未知」，避免再次执行原指令。强杀宿主或代理自行脱离进程组时，操作系统可能留下子进程。

## 验证范围

`pnpm -C packages/node test` 使用临时配置、本地 WebSocket hub 和假代理进程，经过真实 SDK、stdio 和 MCP 工具调用。macOS 已验证这些路径，包括进程树退出。Windows 11 x64 实机已验证 npm 命令探测、中文目录、junction、配置 ACL、进程树退出和报告回传。登录自启和真实账号任务的验证范围见 [Windows 验证记录](../../docs/node/windows.md#本机验证记录)。
