# Alter 工程评测 · 2026-11-26

在同一段流式回答中，每次收到片段都扫描已经显示的历史，代价会随历史长度重复增长。另一处错误发生在星期提醒上，时区跳过整天时，用户指定的星期五会落到星期六。这次把两个问题压缩成可以单独重放的输入，并增加一个能检查真实任务回执的离线入口。

## 配对结果

基线为 `backup1126` 的 `9dcd6c1`。重放在 `refactor/1126` 的 `132cae3` 读取修复后的两个源文件。两端使用同一台 macOS arm64、Node v24.15.0、ICU 78.2、tzdata 2026a 和同一脚本。JSON 附有源文件 SHA-256。[执行脚本](artifacts/replay.mjs) · [基线原始数据](artifacts/replay-before.json) · [修复后原始数据](artifacts/replay-after.json)

| 工作负载与观察量 | 基线 | 修复后 |
|---|---:|---:|
| 200 条历史，256 次累积文本更新，读取已落定记录 ID 的次数 | 51,200 | 200 |
| 重放 32 次相同草稿，返回新状态对象的次数 | 32 | 0 |
| 依次插入 200 条时间递增的记录，读取时间戳的次数 | 39,800 | 398 |
| 修正已有记录时间后仍按时间排序 | 否 | 是 |
| 7 个本地时间固定样例，返回预期 UTC 时刻 | 5/7 | 7/7 |
| 预装锁定依赖后禁网运行 `pnpm demo`，成功退出 | 0/3（无此命令） | 3/3（输出一致） |

使用仓库固定的 Node v24.21.0（ICU 78.3，tzdata 2026c）重新从两个提交读取源码，时间案例及 reducer 的每一列观察均相同。上表的 demo 和最终工作区核验使用这个固定版本。[固定版本基线](artifacts/before/replay-node-pinned.json) · [固定版本升级后](artifacts/after/replay-node-pinned.json)

这里计数的是 JavaScript getter 调用与返回对象的身份。日历判定比对 UTC 毫秒。没有计时浏览器绘制、模型首 token、SSE 网络传输或生产负载。离线 demo 的基线表示当时缺少该根命令，当时已有的 mock 和集成测试仍然可用。[基线 demo 日志](artifacts/before/demo.json) · [修复后 demo 日志](artifacts/after/demo.json) · [实际终端输出](artifacts/after/demo-1.log)

## Bad cases 与修复

**一个回答反复读取聊天历史。** `delta` 携带当前回答的全部已生成文本。基线 reducer 对每个片段调用 `timeline.some`，用来防止已结束的回答被迟到的包重新打开。200 条记录、256 个片段正好触发 51,200 次 ID 读取。修复利用现有状态的不变量：相同 ID 的最终记录和重新连接的快照都会清除草稿。因此只有切换到另一个回答时才需要检查历史。完全相同的重播直接返回原状态。反例测试先结算草稿，再发送迟到片段，也覆盖显示另一个草稿时收到旧回答的片段。[reducer](../../packages/web/src/store.ts) · [回归测试](../../packages/web/test/stream-replay.test.ts)

**时间被修正后行留在原地。** 原先每次插入都排序，但用相同 ID 替换时直接覆盖旧位置。现在先把快照稳定排序一次，顺序到达的记录可以直接附加。迟到的记录和修正过时间的记录重新排序。相同时间保持原有相对顺序。这里仍需查找 ID、复制数组。极长对话的存储开销和 React 渲染耗时是另外的测量问题。

**用户选了周五，提醒却排在周六。** 从 Pacific/Apia 的 2011-12-29 为下一个周五 09:00 建提醒，2011-12-30 这一整天在当地不存在。原实现检查候选墙上时间的星期，随后按缺口规则转换为真实时刻，转换后的当地日期已经是 12 月 31 日。修复对转换后的日期再次检查允许的星期，并留出查找下一周的窗口，返回 2012-01-06 当地 09:00。12 月 23 日出发的样例触达相同根因。没有星期限制的每日提醒，以及纽约春季跳时、秋季重复时刻和上海普通周一均留作对照。[调度逻辑](../../packages/core/src/calendar-time.ts) · [回归测试](../../packages/core/test/calendar-weekday.test.ts)

## 给产品经理

一次正常交互应有一个能追踪完成状态的任务。运行 `pnpm demo`，用户从命令行提出读取笔记，主会话派单，工作会话返回笔记正文和引用，主会话把结果送回。演示在临时 SQLite 中核对了工作会话的工具结果、任务完成状态、账本条目和最终答复。评审者可以断网运行，首次安装依赖需要访问包仓库或事先填充的缓存。

上述时间回归直接改变了用户会在哪一天收到提醒。时间线实验则证明同一草稿重播不再创建状态、修正时间后条目会归位；这些数据还不足以估算用户等候时间。为了保留读者看到的历史、审批与任务状态，本次没有用丢弃片段或缩短历史换取更低的计数。[离线 demo](../../packages/evals/demo.ts)

## 给 AI / Agent 开发者

- 主会话处理用户输入并决定派单或租用工具。独立任务使用 fresh 或 fork 上下文，结束后用 `finish` 交付摘要及引用；主会话接收任务报告。租约限定工具何时对主会话可用，实际调用的授权由 broker 判断。工具效果按 `read`、`write`、`irreversible` 分类；显式能力授权可以覆盖该能力的不可逆动作。[主会话与租约](../adr/0002-main-session-control-plane-and-leases.md) · [当前审批语义](../adr/0021-permission-loosening.md)
- 已验证入口（Surface）的用户原话与 Connector 收到的外部内容具有不同来源。后者经过事件总线与分诊，送入模型的文字本身不能扩大权限。普通用户会话、代理上下文和副作用执行点各自承担一部分约束。历史评测也记录过误放，不能把这层设计宣传为全面抵御提示注入。[入口与连接器](../adr/0003-surface-vs-connector.md) · [审批案例与限制](../adr/0021-permission-loosening.md)
- 此次改动落在客户端已解码事件的 reducer、核心本地时间计算，以及单独的评审入口。生产 SSE 帧、HTTP 路由、配置变量与部署路径沿用基线。对已结算 ID 的迟到事件、快照替换和时间修正都有可执行反例。若要估算 token 费用或实际交互延迟，需要单独使用固定模型、请求集和可核查的使用记录，本轮没有采集这类数据。

## 给后训练 / 评测工程师

| 层次 | 输入与判据 | 失败应归到哪里 |
|---|---|---|
| Web reducer | 累积文本、重播、结算后迟到、顺序追加和时间修正；用 getter、对象身份与最终顺序判定 | 客户端状态管理 |
| 时间换算 | 显式时区、起点、星期、当地目标时间与手写 UTC 期望值 | 调度算法或 ICU/tzdata 差异 |
| 离线任务 | 固定意图与脚本模型、真实运行时和临时 SQLite；核对工作会话回执、账本和用户可见答复 | 模型夹具、调度、工具或持久化，可逐层检查 |
| 既有工作区测试 | 各包独立测试；评测包另有离线任务判定、跳过策略、分诊和观测效果测试 | 区分缺依赖、运行器错误、策略拒绝、任务失败 |

这些样例从已知缺陷构造，可被开发者和脚本模型看到，适合作为回归门槛。七个时间输入中两项共享一次历史变更。固定模型的输出不能作为未见提示上的准确率。评测真实模型时，需要隔离开发样本和留出集，按场景与副作用分层计分，并分别记录「未尝试」「被拒绝」「已发生效果」和运行器故障。这里没有用历史模型跑分补充本次结果。

## 工作区审计与验证

| 包 | 本次检查的边界 |
|---|---|
| `core` | 主会话、任务账本、工具租约、Surface 观察和提醒。改动集中在本地时间的星期选择。 |
| `server`、`web` | 服务端生成状态和 SSE，客户端消费快照、片段和结算事件。仅修改 Web 的纯 reducer。 |
| `evals` | 检查现有任务 oracle 与离线测试，增加调用真实 core 的独立 demo 入口。 |
| `plugin-calendar`、`plugin-sdk` | 本地 SQLite 日历与插件契约。复用既有接口，通过工作区测试观察兼容性。 |
| `adapters`、`gateway`、`node`、`node-protocol` | 识别配置、网关、节点连接、进程适配和协议职责；保留文件与调用点，使用既有测试。 |
| `plugin-mail`、`plugin-feishu`、`plugin-browser`、`plugin-sources`、`plugin-runtime` | 识别传输、账号、来源拉取与外部进程宿主边界；保留实现，使用既有 mock 测试。 |

**Linux 离线全仓验证通过。** 从两个 Git 提交分别提取源代码，按同一锁文件安装依赖，再以普通用户运行断网容器。两端使用同一 linux/arm64 镜像摘要、Node v24.22.3、pnpm 11.3.0、UTC、单包并发、一个 Vitest worker 和默认断言期限。真实模型及线上连接器不参与。构建耗时出现在原始日志中，主机与其他任务共享，本报告没有把这些时长作为性能对比。[可复现容器脚本](artifacts/run-linux.sh) · [镜像与版本](artifacts/after/linux/environment.log)

| 完整命令 | 基线 9dcd6c1 | 升级后 ced83c5 |
|---|---:|---:|
| `pnpm test` | 555/555 通过 | 561/561 通过 |
| `pnpm typecheck` | 退出 0 | 退出 0 |
| `pnpm --filter @alter/web build` | 退出 0 | 退出 0 |

新增的六项回归分别覆盖 Web 草稿重放、排序与重连，以及日历的缺失星期和普通春季缺口。两端的 evals 包均通过全部 23 项。node-protocol 的官方 test 脚本仅打印 “no tests”，未计入 Vitest 用例数。[基线逐包计数](artifacts/before/linux/test-counts.json) · [升级后逐包计数](artifacts/after/linux/test-counts.json) · [基线测试原文](artifacts/before/linux/tests.log) · [升级后测试原文](artifacts/after/linux/tests.log) · [类型检查](artifacts/after/linux/typecheck.log) · [生产构建](artifacts/after/linux/web-build.log)

**macOS 的默认命令存在间歇失败。** 在固定 Node v24.21.0、pnpm 11.3.0、默认并发下，两端均在未改动的 adapters 测试中止。该用例等待本地 HTTP 夹具，有 2 秒截止时间；同一测试文件在升级版单独运行时通过。串行复测也出现过其他断言或超时，涉及模拟服务和子进程。日志不能据此确定这些 macOS 失败的唯一原因。两端的类型检查和 Web 构建均通过。[基线默认命令与退出码](artifacts/before/workspace.json) · [基线单测日志](artifacts/before/tests.log) · [升级版默认命令与退出码](artifacts/after/workspace.json) · [升级版单测日志](artifacts/after/tests.log) · [单独运行 adapters](artifacts/after/isolated-adapters.log)

Linux 首轮没有为容器启用 init。两版都有五个子进程退出测试超过期限；为同一镜像加上 `--init` 后，基线单独重跑这五个用例全部通过。该选项为孤儿子进程提供回收者，全量复核沿用此启动方式。没有修改测试、审批逻辑、超时阈值或平台适配代码。[Linux 基线首轮](artifacts/before/linux-before-init/tests.log) · [Linux 升级版首轮](artifacts/after/linux-before-init/tests.log) · [同镜像定向复核](artifacts/before/linux-before-init/with-init-focused.log)

**保留失败的运行。** `initial-workspace/` 记录 Node 24.15、单包并发及两个 Vitest worker 的首次配对。`node-24.15-all-packages/` 记录该版本的单 worker、继续执行全部包的结果：基线 553 通过、2 失败，升级后 555 通过、6 失败。该模式的 pnpm 返回了 0，但 Vitest 明确报告失败，以上统计读取各包的实际结果。`pinned-serial/` 记录 Node 24.21 的串行运行。上述失败未归入架构改进或性能收益。[基线全部包计数](artifacts/before/node-24.15-all-packages/test-counts.json) · [升级后全部包计数](artifacts/after/node-24.15-all-packages/test-counts.json) · [计数脚本](artifacts/count-tests.mjs)

## 公开数据与敏感内容审计

对基线与展示页提交 `ced83c5` 各自可达的 Git 历史执行 Gitleaks 8.30.1 的默认规则（均无匹配），并对提交树中的 HTTP(S)/WS(S) 字面量按类型归类，再人工复核非标准主机、userinfo 和 IP 所在行。地址审计只输出文件名与行号。复核所见为本地回环入口、公开上游、动态地址模板、占位地址或测试输入。非回环私网 IP 的 URL 位于插件宿主的地址过滤单测，userinfo URL 也位于同一组负向测试。审计没有验证账号所有权、线上可用性或运行时拼接的目标。[基线凭据扫描](artifacts/before/gitleaks.log) · [升级后凭据扫描](artifacts/after/gitleaks.log) · [URL 检查脚本](artifacts/audit-tree.py) · [基线位置](artifacts/before/urls.json) · [升级后位置](artifacts/after/urls.json)

另有两处需要交给发布方的隐私判断。既有审批夹具 `packages/evals/judge-samples.ts` 包含个人域名样式的邮件地址，`packages/web/dev/mock-server.ts:298` 包含本机主目录字面量。前者没有在该文件里用作 HTTP 地址。遵照黑盒规则保留原文，本报告仅列位置。扫描未发现可确认的个人凭据或实际私人服务 URL；个人标识仍存在，不能承诺全仓匿名。

## SKIPPED_BLACKBOX

保留基线的下列实现、签名及既有调用点。只读部署文档确认 ServerX 有 Alter 网关及实例记录，本次没有接入线上服务。`git diff --name-status --diff-filter=MD backup1126 ced83c5` 显示，原有文件中仅根 README、根 package.json、Web reducer 与核心时间函数发生修改，没有删除文件。

- `packages/{gateway,node,node-protocol,adapters}/`，包括代理、节点连接、平台执行器、凭证存储、安装与 launchd 文件。
- `packages/plugin-{mail,feishu,browser,sources,runtime}/`，包括真实服务、外部请求、来源轮询、脚本、宿主进程、凭据及 SDK 接入点。
- `packages/server/src/` 的部署、认证、网关信任、密钥、适配器、节点和插件接入；`packages/core/src/` 的网关、模型、宿主、事件、任务、审批与插件调用点。
- 既有 `packages/evals/` 中使用提供方、浏览器或邮件的入口和夹具（包括 `judge-samples.ts`），以及 `packages/web/dev/mock-server.ts`、生产配置样例、已有接入文档与历史实测记录。
- 所有现有第三方平台操作、网络协议及其调用保留。新增 demo 只接入已有的本地应用入口、脚本模型和示例笔记。

## 复现

从带有对比提交的本地仓库运行。命名分支也可换成原始 JSON 记录的提交 SHA。每一端独立安装锁文件，下面的命令在 POSIX shell 中运行。输出目录放在临时位置，保留随仓库提供的原始记录。

```sh
pnpm install --frozen-lockfile
pnpm demo
node docs/evals/artifacts/replay.mjs backup1126
node docs/evals/artifacts/replay.mjs 132cae3

runner="$PWD/docs/evals/artifacts"
scratch="$(mktemp -d)"
git worktree add --detach "$scratch/before" backup1126
git worktree add --detach "$scratch/after" ced83c5
for tree in before after; do
  (cd "$scratch/$tree" && pnpm install --frozen-lockfile &&
    node "$runner/run-workspace.mjs" "$scratch/logs/$tree")
  (cd "$scratch/$tree" && node "$runner/check-demo.mjs" "$scratch/logs/$tree")
done
```

运行 `sh docs/evals/artifacts/run-linux.sh backup1126 ced83c5 "$scratch/linux"` 可以在指定的 linux/arm64 镜像中生成独立测试、类型检查和构建日志。脚本只在安装依赖时使用容器网络，测试容器使用 `--network none` 和 `--init`。

在 macOS，demo 检查器通过 `sandbox-exec` 禁止网络；其他系统运行相同脚本时会在 JSON 中记录没有施加该系统级限制。基线的 demo 检查预期返回非零。每份演示日志都保留了实际退出情况。运行工作区脚本会在相应 checkout 内生成正常构建产物。
