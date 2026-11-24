# ADR-0007 邮箱插件：基于成熟库自写 Connector

- 状态：已接受
- 日期：2026-11-22
- 讨论：#7

## 背景

邮箱插件需要：作为事件源实时接收新邮件（M4 主动分诊）；每个动作声明副作用等级（ADR-0004）；发送幂等；邮件正文标记为不可信数据（ADR-0003）；跨平台。

## 决策

用 **imapflow**（IMAP，含 IDLE）+ **nodemailer**（SMTP）+ **mailparser**（MIME 解析）自写 Connector。三者同属 postalsys，MIT 许可，持续维护。

- 协议层交给库；产品层（动作清单、事件源、幂等、来源标记）自己写。
- 首个接入的邮箱是 **163**。

## 备选方案

| 方案 | 没选的理由 |
|---|---|
| 完全从头写 IMAP/SMTP | 协议细节多、无差异化价值 |
| himalaya CLI | 拿不到实时推送；需额外二进制；幂等与来源标记要再包一层。保留为 skill-cli 接入的演示样例 |
| 现有邮件 MCP server | 项目很新、几乎无人使用 |

## 后果

- 163 的 IMAP 要求客户端在登录后发送 `ID` 命令，否则拒绝访问（"Unsafe Login"）；imapflow 支持 `clientInfo`。
- 发送幂等：每次发送由任务生成稳定的 `Message-ID` 并记入审计；重试前先在"已发送"文件夹按 `Message-ID` 查重。

## 如何验证

- 真实 163 账号上：搜索、读取、存草稿、发送（发给自己）全部走通；发送在 auto 档挂起等待用户批准。
- 崩溃测试：发送过程中杀进程，恢复后不重复发送。
- 新邮件在 IDLE 下 10 秒内进入事件队列。

## 修订（#123）

邮件工具以文件夹路径和 UID 定位邮件，省略文件夹时使用 INBOX。按 ADR-0021 声明以下效果。

| 工具 | 效果 | 行为 |
| --- | --- | --- |
| `mail_folders` | read | 列出完整路径、特殊用途、总数和未读数。服务端未提供的计数返回 null。 |
| `mail_search` | read | 按发件人、收件人、主题、全文、日期、未读、星标和有无附件组合搜索。按 UID 从新到旧返回，默认 20 封，最多 100 封。 |
| `mail_read` | read | 读取信封头、纯文本正文、Message-ID、References，以及从 1 开始编号的附件名、类型和 MIME 结构报告的大小。 |
| `mail_attachment` | read | 按附件序号下载到插件数据目录的 `attachments/`，返回绝对路径、类型和实际解码字节数。 |
| `mail_contacts` | read | 从 INBOX 和 Sent 各取最近最多 1,500 封，汇总双方地址、显示名、往来邮件数和最近时间。排除本账号，可按名字或地址筛选。 |
| `mail_draft` | write | 保存纯文本草稿到 Drafts。 |
| `mail_send` | write | 向指定地址发信，返回 Message-ID。 |
| `mail_reply` | write | 优先回复 Reply-To。回复全部时纳入原 To 和 Cc，去重；通过 In-Reply-To 和 References 延续线程。 |
| `mail_forward` | write | 转发完整正文给指定收件人，可加说明，默认携带原附件。 |
| `mail_mark` | write | 批量设置或清除已读、星标，保留其他标志。 |
| `mail_move` | write | 将指定 UID 移到已有文件夹。支持原生 MOVE，或通过 UIDPLUS 定向清除已复制的源邮件。 |

搜索尽量交给 IMAP SEARCH。日期使用服务器收信日期，包含 `since` 当天，排除 `before` 当天。附件条件由 MIME 结构判断。163 的文本类 SEARCH 存在已知兼容问题，改用服务器返回的日期、标志候选集，按批检查信封和正文，直到满足条数或遍历完候选集。

附件目录在首次下载时创建，可通过 `MailConfig.dataDir` 指定，默认使用宿主数据目录下的 `mail/`。文件名清除路径成分，加上账号、文件夹、UIDVALIDITY、UID 和附件序号的摘要前缀；下载完整后原子替换。同一 UID 在不同文件夹内可指向不同邮件。

发送、回复和转发共用 `alter.mail-sends` 回执和 Sent 查重。同一工具任务重放沿用原 Message-ID。若 SMTP 未确认且 Sent 中找不到副本，工具返回投递状态未知，交由用户核对。回复和转发先检查回执，再读取原信，因此完成归档后移走原信也能恢复原结果。
