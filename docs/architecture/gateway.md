# 多用户网关

网关负责登录、邀请码和实例路由。初始管理员沿用已有的 Alter 数据和正式实例。通过邀请码注册的账号各有一个进程，一个 SQLite 业务库和一个固定端口。设计背景见 [ADR-0026](../adr/0026-gateway-and-nodes.md)。

## 在管理员 Mac 部署

在仓库根目录使用 Node 24 和仓库指定的 pnpm 版本。安装 workspace 依赖，构建网页，再启动网关。

```sh
pnpm install --frozen-lockfile
pnpm --filter @alter/web build
node packages/gateway/src/main.ts
```

网关和正式实例都从仓库根目录加载可选的 `.env`，已导出的环境变量优先。首次部署需要配置模型和 `ALTER_WEB_PASSWORD`。正式实例需运行包含网关认证支持的 server 版本，沿用原有 launchd 配置、Web 密码和会话。网关可以先于正式实例启动。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ALTER_GATEWAY_HOST` | `127.0.0.1` | 网关监听地址 |
| `ALTER_GATEWAY_PORT` | `4300` | 网关监听端口 |
| `ALTER_GATEWAY_DATA` | `<仓库>/data/gateway` | 账号库 `accounts.sqlite` 和共享密钥文件目录。相对路径从仓库根目录解析 |
| `ALTER_ADMIN_INSTANCE` | `http://127.0.0.1:4317` | 本机已有管理员实例的 HTTP 地址 |
| `ALTER_ADMIN_USERNAME` | `admin` | 初始管理员用户名，使用与注册相同的用户名格式 |
| `ALTER_WEB_PASSWORD` | 首次初始化必填 | 用于创建网关初始账号。此后网关密码保存在账号库内，正式实例直连的密码仍从环境读取 |
| `ALTER_GATEWAY_SECRET` | 自动生成 | 网关与正式实例共享的密钥。显式配置时，两进程须使用相同值 |
| `ALTER_INSTANCE_BASE_PORT` | `4400` | 新用户端口从此处递增，跳过网关和正式实例的端口。已有分配保存在账号库中 |

每个用户的数据目录为网关数据目录的同级目录 `users/<userId>/`，默认是 `data/users/<userId>/`。备份时同时保存账号库、密钥文件和各实例的数据目录，以保持账号、会话、端口与业务数据的对应关系。

### launchd

模板位于 [top.raymor.alter-gateway.plist](../../packages/gateway/launchd/top.raymor.alter-gateway.plist)。将模板中的 `__NODE__` 替换为稳定的 Node 24 可执行文件绝对路径，`__REPO__`、`__HOME__` 替换为仓库和用户主目录的绝对路径。launchd 不展开波浪号或 shell 变量。

准备 `~/Library/Logs/Alter/`，将填好的文件放到 `~/Library/LaunchAgents/top.raymor.alter-gateway.plist`。部署时可用下列命令检查并加载。服务以登录用户身份运行，输出和错误都写入 `~/Library/Logs/Alter/gateway.log`。

```sh
plutil -lint "$HOME/Library/LaunchAgents/top.raymor.alter-gateway.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/top.raymor.alter-gateway.plist"
launchctl print "gui/$(id -u)/top.raymor.alter-gateway"
```

## 认证、路由与实例生命周期

- 网关用随机盐和 scrypt 保存密码。会话令牌仅以 SHA-256 摘要写入 SQLite，有效期一年。Cookie 为 `alter_gw_<网关端口>`，属性为 `Path=/; HttpOnly; SameSite=Lax`。HTTPS 反代须覆盖 `X-Forwarded-Proto` 为 `https`，网关据此加上 `Secure`。
- 登录限速独立统计用户名和来源 IP，每个滚动分钟各允许十次失败。达到任一上限返回 `429`。本机反代可通过覆盖 `X-Real-IP` 传入真实来源；网关忽略非回环对端提供的该头。退出会话会关闭该会话已有的代理连接。管理员修改账号会撤销其所有会话并关闭已有连接，停用还会结束受管实例。
- 未登录访问网页时，网关提供 `packages/web/dist` 的静态文件和 SPA 回退，访问 `/api/*` 返回 JSON 错误。已登录的 HTTP、SSE 和 WebSocket 直接流式转发。网关剥离客户端携带的三个身份头，以及网关和实例的会话 Cookie，再向实例写入 `X-Alter-User`、`X-Alter-Username` 和 `X-Alter-Gateway-Secret`。
- 网关与正式实例优先使用环境密钥。未配置时，网关在数据目录生成权限为 `0600` 的 `secret`，正式实例按需读取同一路径，因此两者使用相同的 `ALTER_GATEWAY_DATA`。网关按用户 ID 从主密钥派生子实例密钥，各子实例只接收自己的值。
- `ALTER_AUTH=gateway` 的实例对静态文件、API 和升级请求均校验本机 IPv4 回环对端与密钥。通过认证后，内置的 `/api/login` 和 `/api/logout` 返回 `404`。密码模式的正式实例同时接受本机网关密钥和原有密码会话。
- 网关在首次登录或路由请求时拉起用户实例，继承模型配置，设置 `ALTER_USER_ID`、独立的 `ALTER_DATA_DIR` 和 `ALTER_WEB_PORT`，监听 `127.0.0.1`。子进程完成插件启动后通过 IPC 报告就绪。短时间内连续退出会以 0.5、1、2 秒等间隔重试，上限 60 秒。运行超过一分钟后重置退避。空闲实例持续运行，网关退出会收回子进程。
- 受管实例始终使用 `ALTER_ROLE=user` 和 `ALTER_BROWSER=off`。飞书、ego 浏览器、CLI/MCP/HTTP 转接器、自写插件和宿主机服务管理不可用，相关接口返回 `403`。用户仍可配置自己的邮件和消息来源。子进程会清除继承的管理员邮箱与飞书配置。
- 网关角色控制账号和邀请码管理。晋升账号保留其个人实例和数据；宿主机专属能力属于最初绑定的正式实例。初始管理员必须保持启用且保留 admin 角色。正式实例的生命周期仍由原服务管理。
- `/api/node/connect` 的 WebSocket 升级使用 `Authorization: Bearer <userId>.<secret>`。网关按令牌里的用户 ID 找到启用账号，转发原始 Authorization、握手和后续双向数据。实例负责验证节点密钥。实际节点握手依赖实例侧 #149；同一路径的 HTTP 请求也按节点令牌路由，缺少令牌时返回 `401`。见[节点协议](node-protocol.md)。

## 网关接口

写请求使用 `Content-Type: application/json`，无参数时可发送 `{}`。错误体为 `{ "error": "..." }`。成功响应中时间为 Unix 毫秒，尚未发生的时间为 `null`。

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /gateway/register` | `{ username, password, invite }` | `201`，返回身份。注册后调用登录获得会话 |
| `POST /gateway/login` | `{ username, password }` | `200`，返回身份，设置 Cookie |
| `POST /gateway/logout` | `{}` | `204`，清除 Cookie |
| `GET /gateway/me` | 已登录 | `200`，返回 `{ id, username, role }` |
| `GET /gateway/admin/users` | 管理员 | 用户数组，含 `disabled, createdAt, lastLoginAt, port, instance` |
| `PATCH /gateway/admin/users/:id` | `{ disabled?, role?, password? }` | 更新后的用户及实例状态 |
| `POST /gateway/admin/users/:id/restart` | `{}` | `204`，受管实例已就绪。对正式实例、停用账号返回 `409` |
| `GET /gateway/admin/invites` | 管理员 | 邀请码数组 |
| `POST /gateway/admin/invites` | `{ days? }`，正整数，默认 7 | `201`，新邀请码记录 |
| `DELETE /gateway/admin/invites/:code` | 管理员 | `204`，撤销邀请码并保留记录 |

用户名区分大小写，限 3–20 位英文字母、数字或下划线。注册密码至少 8 位。注册与消费邀请码在同一 SQLite 事务内完成。重名返回 `409`，邀请码过期、撤销或已使用返回 `400`。管理接口未登录返回 `401`，普通账号返回 `403`。

用户记录的 `port` 是持久化的分配值，正式实例为 `null`。展示端口请读 `instance.port`。`instance` 包含 `managed`、`port`、`rss`（字节，无法取得时为 `null`）和 `status`（`stopped | starting | running | backoff | stopping | unavailable`）。列表读取不会启动空闲实例。邀请码记录包含 `code, createdBy, createdAt, expiresAt, usedBy, usedAt, revoked`。

## nginx 与 frp

公网 nginx 终止 TLS。frp 使用 TCP 隧道，把公网机回环上的 14300 转发到 Mac 网关的 4300。让公网仅能通过 nginx 访问网关，避免直接访问隧道端口时伪造代理头。以下域名、认证令牌和证书路径为部署占位值。

公网机的 `frps.toml` 中指定代理监听地址（此设置作用于该 frps 的代理端口，已有共享部署也可通过防火墙限制 14300）。

```toml
bindPort = 7000
proxyBindAddr = "127.0.0.1"
auth.method = "token"
auth.token = "REPLACE_WITH_FRP_TOKEN"
```

Mac 的 `frpc.toml` 使用同一令牌。

```toml
serverAddr = "frp.example.org"
serverPort = 7000
auth.method = "token"
auth.token = "REPLACE_WITH_FRP_TOKEN"

[[proxies]]
name = "alter-gateway"
type = "tcp"
localIP = "127.0.0.1"
localPort = 4300
remotePort = 14300
```

nginx 的 `http` 块中加入下列配置。关闭代理缓冲和压缩使 SSE 帧及时送达，HTTP/1.1 和 Upgrade 头用于节点与网页 WebSocket。

```nginx
map $http_upgrade $alter_connection {
    default upgrade;
    ''      '';
}
server {
    listen 443 ssl;
    server_name alter.example.org;
    ssl_certificate     /etc/nginx/tls/alter.crt;
    ssl_certificate_key /etc/nginx/tls/alter.key;

    location / {
        proxy_pass http://127.0.0.1:14300;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $alter_connection;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        gzip off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```
