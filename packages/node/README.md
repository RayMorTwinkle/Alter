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

节点启动时在 PATH 中查找以下命令，用 `--version` 探测可用性。先在电脑上安装所需代理，并在代理自己的界面完成登录或模型供应商配置。Windows 的 npm 全局 `.cmd` 包装同样适用。

| 代理 | 节点启动方式 | 已有会话来源 |
| --- | --- | --- |
| Claude Code（`claude-code`） | Agent SDK 驱动 `claude` | SDK 的 `listSessions` |
| Codex（`codex`） | `codex app-server`，stdio v2 | `thread/list` |
| DeepSeek Harness（`dsh`） | `dsh --profile acp`，stdio ACP v1 | `session/list`，标题取首条用户消息 |
| opencode（`opencode`） | `opencode acp`，stdio ACP v1 | `session/list`，由代理提供标题与更新时间 |

### 列出和续接已有会话

在 Alter 主会话中让助手列出某台电脑上指定代理的已有会话，可以指定工作目录。节点按更新时间从新到旧返回，默认 20 条。指定目录只返回该目录的会话，省略时包含所有已授权 roots 及其子目录。列表查询 20 秒超时，可重试。

选中会话后，节点在该会话 ID 上续写，之后可以在代理原界面查看。dsh 只读本地 v3 日志，取文件修改时间和首条用户消息的前 120 个字符；旧格式或损坏日志仍可按 ID 续接。若代理报告会话已被占用，请先关闭原界面中的该会话，再从 Alter 重试。

### 默认模型

在代理自己的模型选择界面查看供应商和模型名，然后在已配对的节点上设置。下面是 shell 示例，dsh 的值是包含供应商和模型的 JSON 数组字符串，opencode 使用 `provider/model`。请选用本机已配置密钥的供应商，opencode 可通过 `opencode auth login` 登录。

```sh
alter-node harness model dsh '["zen","deepseek-v4-flash"]'
alter-node harness model opencode 'zen/deepseek-v4-flash'
alter-node harness model dsh
alter-node harness model dsh --clear
```

相同命令支持 `claude-code`、`codex`。省略值显示当前设置，`--clear` 恢复代理默认值。下一次新建会话即采用新设置，续接时保留原会话模型。节点下次连接时把当前设置随 hello 上报。dsh 通过新建会话才能从 ACP 查询可选模型，且该版本没有删除会话的接口，因此节点 CLI 省略了 `harness models` 命令。

### 审批和报告

各代理先执行自身的权限规则与沙箱设置，只有代理发出的审批请求才会到达 Alter。原生规则已允许或拒绝的操作可能没有 Alter 审批卡片。

| 任务档位 | Claude Code（Agent SDK） | Codex（app-server） | ACP（dsh、opencode） |
| --- | --- | --- | --- |
| restricted | default，转发 canUseTool 审批 | untrusted，read-only | 每个原生权限请求都问 hub |
| auto | acceptEdits，原生规则可直接允许编辑 | on-request，workspace-write | read、search、fetch、edit 自动允许一次，其余问 hub |
| full | bypassPermissions | never，workspace-write | 自动允许一次 |

授权范围由 hub 记忆。ACP 只选择代理提供的一次性允许或拒绝选项；缺少对应选项时回复取消。ACP 的标准权限响应没有传回拒绝附注的字段。ACP 客户端未开放文件和终端服务，代理通过自身工具操作。代理提供 `reasoning_effort` 时，节点会应用任务的 thinking 档位；选项只有 low 和 high 两个相邻档位时，medium 取 low。

同一任务的补充消息按到达顺序排队，本轮结束后在同一会话开始下一轮。每个任务只结算一次，先取最后一轮的 `finish({summary, refs})`，其次取本轮最后的非空助手正文。两者均为空时报告失败。中断、崩溃或超时优先报告原因及已有输出。单个任务的总时限为 4 小时，包含审批等待时间。

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

`pnpm -C packages/node test` 使用临时配置、本地 WebSocket hub 和假代理进程，经过真实 SDK、stdio 和 MCP 工具调用。macOS 已验证这些路径，包括进程树退出。此前 Claude Code 与 Codex 已在 Windows 11 x64 实机验证 npm 命令探测、中文目录、junction、配置 ACL、进程树退出和报告回传。登录自启和真实账号任务的验证范围见 [Windows 验证记录](../../docs/node/windows.md#本机验证记录)。
