# 节点：Windows 端开发说明

给在 Windows 电脑上工作的 Codex 读。先读 ADR-0026、`docs/architecture/node-protocol.md`、`packages/node-protocol/src/index.ts`，以及 `packages/node` 的 macOS 实现（已完成并在 macOS 上用真实 Claude Code 验证）。目标：同一份 `packages/node` 代码在 Windows 10/11 x64 上同样可用，不分叉出 Windows 专用版本。

## 环境

- Node.js 24 LTS（官方安装包），启用 corepack 后用 pnpm（版本见根 `package.json`）。
- Git for Windows。
- 被驱动的代理按需安装：Claude Code（`npm i -g @anthropic-ai/claude-code`，或官方安装器）、Codex CLI、opencode。各自先手动登录一次。
- 不要读取或提交任何 `.env`、token、代理的登录凭据。

## 需要确认或修改的地方

1. **启动子进程**：Windows 上 npm 全局命令是 `claude.cmd`、`codex.cmd` 这类批处理包装，`child_process.spawn("claude")` 会找不到。统一走 `packages/node/src/spawn.ts` 的解析：按 `PATHEXT` 查找可执行文件；`.cmd/.bat` 需通过 `cmd.exe /d /s /c` 并正确转义参数（或使用 `cross-spawn`）。Claude Agent SDK 支持 `pathToClaudeCodeExecutable`，传解析出的真实路径。
2. **代理探测**：`detectHarnesses()` 在 Windows 上要能找到上述命令并读出版本；找不到时 `available: false` 并给出 `detail`（例如"未安装 Claude Code"）。
3. **路径**：`roots`、`cwd` 用 `path.win32` 语义比较，大小写不敏感，处理盘符与 `\\?\` 前缀；校验 `cwd` 在 root 内时先 `realpath` 再比较，防止通过 junction 逃逸。
4. **配置目录**：`%APPDATA%\alter-node\`（`config.json`、`outbox\`、`logs\`）。`config.json` 含 token，写入后只给当前用户读写权限（用 `icacls` 或 Node 写文件后再收紧 ACL；做不到时在文档中说明）。
5. **进程树结束**：`task.stop` 与节点退出时要结束代理的整个进程树。Windows 上 `child.kill()` 不会结束孙进程，用 `taskkill /pid <pid> /T /F`。
6. **换行与编码**：JSON-RPC 按 `\n` 分帧，兼容 `\r\n`；子进程输出按 UTF-8 解码（必要时设置 `chcp 65001` 或环境变量），中文路径与输出不能乱码。
7. **MCP finish 工具**：节点给代理的 MCP 配置里，命令用 `process.execPath`（node.exe 的绝对路径）加脚本绝对路径，不依赖 PATH。
8. **开机自启（可选，第二步）**：`alter-node install-service` 在 Windows 上用「任务计划程序」创建登录时启动的任务（`schtasks /Create /SC ONLOGON ...`），`uninstall-service` 删除。macOS 对应 launchd，Linux 对应 systemd --user。
9. **测试**：`pnpm -C packages/node test` 在 Windows 上全部通过；涉及路径和进程的测试加 Windows 分支用例（`.cmd` 包装、盘符、大小写、进程树结束）。CI 不要求，但在 Windows 本机跑通。

## 验收

1. `alter-node pair --server <hub 地址> --token <token> --name 宿舍台式` 成功写入配置。
2. `alter-node run` 连上后，网页「我的电脑」显示该节点在线及可用代理。
3. 在网页对主会话说"用我宿舍台式上的 Claude Code，在 D:\\code\\demo 里新建 hello.txt 写入 hi"，能看到审批卡片（restricted），允许后文件被创建，任务报告回到主会话。
4. 任务运行中断网再恢复，事件不丢不重；`task.stop` 后代理进程树全部退出。

完成后提交到独立分支，PR 描述写明在哪台 Windows（版本）上验证了哪些步骤。

## 本机验证记录

2026-11-25，`feat/node-windows`，Windows 11 IoT 企业版 Insider Preview x64。`[Environment]::OSVersion` 返回 `Microsoft Windows NT 10.0.29695.0`。Node.js 24.22.3 由 mise 管理，pnpm 11.3.0。

| 检查项 | 本机结果 |
| --- | --- |
| 1–2 命令和探测 | mise 的 Node 安装目录同时包含 npm 生成的 `.cmd` 和 `.ps1`。手工运行 `claude --version` 和 `codex --version` 分别得到 2.1.332、0.172.0。节点通过 PATHEXT 找到同目录的 `.CMD`，两个版本均一致。opencode 报告未安装。回归测试覆盖 PS1 排在 CMD 前面的情况，并逐项核对 .cmd 转发的中文、空格、引号、&、末尾反斜杠和空参数。 |
| 3 目录授权 | 临时目录中创建指向 root 外的 Windows junction，节点拒绝该 cwd。另测了盘符、大小写、UNC、设备前缀及相同前缀的相邻目录。 |
| 4 配置 ACL | 在临时 APPDATA 中使用假 token 重新配对。写入走 `whoami` 和 `icacls`，对最终 config.json 执行 `Get-Acl`，确认 DACL 已关闭继承，唯一允许项为当前 SID 的 FullControl。 |
| 5 进程树 | 通过本地 hub 分别向 Claude、Codex 的临时 .cmd 代理发送 task.stop。测试先确认 cmd 包装进程、假代理和子进程的 PID 均存活，再检查中断报告并确认三个 PID 均已退出。节点主动关闭也覆盖相同的树清理。 |
| 6–7 编码和 finish | 在含中文和空格的路径中启动两个适配器。假代理用 UTF-8 和 CRLF 回传中文，经绝对 node.exe 和脚本路径调用 stdio MCP 的 finish，hub 收到结构化中文报告。 |
| 8 登录自启 | 安装使用 schtasks 导入 XML。LogonTrigger 限定当前 SID，任务以交互用户权限运行。用任务计划程序 COM 接口在内存载入定义，核对了触发器、启动程序和参数。自动化测试截获安装及卸载命令。macOS 的 LaunchAgent 和 Linux 的 systemd 用户单元仅验证配置生成。 |

`pnpm -C packages/node test` 的 20 个用例全部通过，`pnpm -C packages/node typecheck` 和 `pnpm -r typecheck` 通过。

`pnpm -r test` 首先在 `packages/plugin-runtime` 失败，两个用例清理临时目录时收到 EPERM，一个锁定依赖用例收到插件协议或执行失败。另一次使用 `--no-bail` 的排查还观察到 core、evals 的 5 秒超时，以及 plugin-feishu、server、gateway 的文件权限位断言失败（期望 0600，得到 0666）。并行排查期间观察到的节点用例超时已调整测试等待时间，随后在本机单独复测通过。

本次真实代理只做版本探测。任务、审批、断线重放和报告均通过临时 hub 与假代理验证。Windows 10、正式 hub 网页与真实账号联调、三个平台的实际登录自启仍待实机验收。
