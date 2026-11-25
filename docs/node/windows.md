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
