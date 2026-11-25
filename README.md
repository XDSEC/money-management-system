# XDSEC 会费账务系统

本系统有以下功能：

- 管账的同学填报收支
- 协会的同学通过协会公号访问系统，查看收支凭据和收支统计
- 可选：协会成员通过 Ory Kratos 统一账号登录查看（见下文）
- 管理员可通过 QQ（OneBot v11）发送消息记账

## 配置

复制 `.env.example` 为 `.env` 并按需修改：

```
PORT=3000
TZ=Asia/Shanghai
# 可选：默认监听所有地址；反向代理场景可设为 127.0.0.1
# HOST=127.0.0.1
BOT_ENABLE=1
BOT_WS_URL=ws://127.0.0.1:3001
BOT_TOKEN=your-onebot-access-token
# Docker 部署可选：只把端口暴露给宿主机本机（配合反向代理）
# BIND_IP=127.0.0.1
```

`.env` 已被 git 忽略。已存在的环境变量优先于 `.env` 中的值。

## 运行

```bash
npm install
node server.js
```

首次打开页面会引导创建管理员账号和查看账号。

## 接入 Ory Kratos 统一账号登录（可选）

设置 `KRATOS_ENABLE=1` 后，登录页会出现「使用协会统一账号登录」，协会成员用统一的 Ory Kratos
账号登录后，以只读身份查看账目、凭据和操作记录。管理员仍使用本地账号记账；本地查看账号保留，
作为 Kratos 不可用时的兜底。不开启时行为与之前完全一致。

### 配置

```
KRATOS_ENABLE=1
PUBLIC_URL=https://ledger.example.com        # 本系统对外地址，必需；把示例替换为实际域名
KRATOS_PUBLIC_URL=http://kratos:4433         # 服务端访问 Kratos（容器内可用服务名）
# KRATOS_BROWSER_URL=https://sso.example.com # 浏览器访问 Kratos 公开 API 的地址，默认等于 PUBLIC_URL
# KRATOS_SESSION_COOKIE=ory_kratos_session
# KRATOS_LOGOUT_PATH=/self-service/browser/flows/logout # Kratos v0.5.x 才需要，v0.6+ 用默认值
```

`KRATOS_BROWSER_URL` 是**浏览器访问 Kratos 公开 API 的基地址**，如果 Kratos 挂在某个路径前缀下
（例如 Ory 官方部署的 `/.ory/kratos/public`），必须把该前缀一起写进去，结尾不要带 `/`。

Kratos **v0.5.x**（如 `oryd/kratos:v0.5.4-sqlite`）的浏览器登出端点还是
`/self-service/browser/flows/logout`，需要用 `KRATOS_LOGOUT_PATH` 指定；该版本的登出不读取
`return_to`，登出后固定跳转 `kratos.yml` 中的
`selfservice.flows.logout.after.default_browser_return_url`，请把它设为账务系统地址。
v0.6+ 使用默认的 `/self-service/logout/browser` 并支持 `return_to`，无需设置。

### 部署要求

本系统需要读取浏览器带来的 Kratos 会话 Cookie，再在服务端调用 `/sessions/whoami` 校验身份。
因此 **Kratos 的会话 Cookie 必须能被账务系统域名收到**，二选一：

**模式 A：同源反向代理（推荐）**

在账务域名的 nginx 上把 Kratos 的公开路径代理过去，浏览器始终只看到 `https://ledger.example.com`：

```nginx
location ~ ^/(self-service|sessions|ui|schemas)/ {
    proxy_pass http://127.0.0.1:4433;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`KRATOS_BROWSER_URL` 保持默认（等于 `PUBLIC_URL`）。Kratos 侧需要：

```yaml
serve:
  public:
    base_url: https://ledger.example.com
selfservice:
  allowed_return_urls:
    - https://ledger.example.com
```

**模式 B：共享父域 Cookie**

账务系统在 `ledger.example.com`、Kratos 在 `auth.example.com` 时，Kratos 需把会话 Cookie
设到父域：

```yaml
session:
  cookie:
    domain: .example.com
    same_site: Lax   # Strict 会让跨站回调丢失 Cookie
```

并设置 `KRATOS_BROWSER_URL=https://auth.example.com`。注意父域 Cookie 会被所有同域子站收到，
安全性不如模式 A。

如果 Kratos 与账务系统完全不同域、又无法共享 Cookie，本方案无法校验会话，需要改用 OIDC（如
Kratos + Ory Hydra），本项目未实现。

### 本协会（xdsec.org）的接入配置

Kratos 已配置 `session.cookie.domain: xdsec.org`，账务系统部署在 `ledger.xdsec.org` 即可直接
收到会话 Cookie，不需要同源反向代理（模式 B）。

Kratos 的公开 API 实际挂在 `https://account.xdsec.org/.ory/kratos/public/` 下
（compose 中的 `SERVE_PUBLIC_BASE_URL`），根路径的 `/self-service/...` 会经过 Oathkeeper 并返回
`404 Requested url does not match any rules`，所以浏览器基地址必须带这个前缀。

1. Kratos 的 `kratos.yml` 把账务域名加入白名单（当前版本 v0.5.3 的键名是
   `whitelisted_return_urls`，升级到新版本后对应 `allowed_return_urls`）：

```yaml
selfservice:
  whitelisted_return_urls:
    - https://account.xdsec.org
    - https://ledger.xdsec.org
  flows:
    logout:
      after:
        # v0.5.x 登出不读 return_to，登出后固定回到这里，所以要设成账务系统地址
        default_browser_return_url: https://ledger.xdsec.org/
```

2. 账务系统的 `.env`（systemd 部署，与 Kratos 在同一台宿主机）：

```
KRATOS_ENABLE=1
PUBLIC_URL=https://ledger.xdsec.org
KRATOS_BROWSER_URL=https://account.xdsec.org/.ory/kratos/public
# v0.5.x 的浏览器登出端点（v0.6+ 删除这一行即可）
KRATOS_LOGOUT_PATH=/self-service/browser/flows/logout
# 必须用不经过 Cloudflare / Oathkeeper 的内网/本机地址，见下面的说明
KRATOS_PUBLIC_URL=http://127.0.0.1:4433
```

注意 `PUBLIC_URL` 要填账务系统的真实域名，不要保留示例值 `ledger.example.com`——它决定回调地址
`https://<PUBLIC_URL>/api/kratos/callback`，也会用于 Kratos 白名单校验。

`KRATOS_PUBLIC_URL` 用于服务端调用 `/sessions/whoami`，**不能填 `https://account.xdsec.org`**：
该域名前面有 Cloudflare，程序请求会拿到挑战页 403（`cf-mitigated: challenge`）。Kratos 运行在
Docker 中时需把公开端口映射到宿主机本机（`ports: ["127.0.0.1:4433:4433"]`），systemd 服务再通过
`http://127.0.0.1:4433` 访问。

验证 Kratos 内网地址可用：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4433/health/alive  # 200
curl -s http://127.0.0.1:4433/sessions/whoami                               # 未登录时 401
```

3. 登录流程：账务系统跳到
   `https://account.xdsec.org/.ory/kratos/public/self-service/login/browser?return_to=https://ledger.xdsec.org/api/kratos/callback`，
   Kratos 再跳到 `https://account.xdsec.org/auth/login?flow=...`；登录成功后回到回调地址并签发本地
   会话。如果自定义登录页没有把 `return_to` 带回来（登录后停在 account 页），成员直接打开
   `https://ledger.xdsec.org` 也会被自动识别登录，因为 Cookie 在整个 `xdsec.org` 域下共享。

   登出流程（v0.5.x）：账务系统跳到
   `https://account.xdsec.org/.ory/kratos/public/self-service/browser/flows/logout`，Kratos 清除会话
   Cookie 后 302 回 `logout.after.default_browser_return_url`（上面设为 `https://ledger.xdsec.org/`）。
   Oathkeeper 的放行规则必须同时覆盖这个路径。

### 行为说明

- 所有通过 Kratos 登录的成员都是只读角色：可以查看收支、凭据和操作记录，不能记账、改密码或
  调整机器人设置。
- 退出时会同时退出本地会话；若浏览器仍持有 Kratos 会话，会跳转 Kratos 登出后再回到登录页，
  避免被自动重新登录。
- 尚未完成初始化（还没有本地账号）时不会走 Kratos 登录，避免绕过初始化页。
- Kratos 不可用时成员会回到登录页，可改用本地查看账号；管理员不受影响。
- 在 Kratos 中禁用用户后，已经签发的只读会话会持续到它过期（Kratos 的 `expires_at`，缺失时
  最长 12 小时）。需要立即吊销时，重启本服务会清空所有本地会话。
- **如果 Kratos 开放自助注册，等于把整本账目公开**：请使用邀请制或关闭自助注册。

### 排错

- 跳转后出现 `404 Requested url does not match any rules`：`KRATOS_BROWSER_URL` 少了 Kratos 公开
  API 的路径前缀（本协会为 `https://account.xdsec.org/.ory/kratos/public`），请求落到了 Oathkeeper。
- Kratos 返回纯文本 `404 page not found`：请求已到达 Kratos，但该版本没有这个路径。v0.5.x 的登出
  端点是 `/self-service/browser/flows/logout`，用 `KRATOS_LOGOUT_PATH` 指定；可用
  `curl -si http://127.0.0.1:4433/<路径>` 直连 Kratos 比对。
- 回调地址里出现 `ledger.example.com` 之类的示例域名：`.env` 里 `PUBLIC_URL` 还是示例值。
- 回调后停留在 `/?kratos_error=1`：浏览器没有把 Kratos 会话 Cookie 带到本系统，或 Kratos 拒绝了
  `return_to`。检查上面的两种部署方式、`whitelisted_return_urls`（新版为 `allowed_return_urls`）、
  Kratos 的 `base_url` 和 Cookie 属性。
- 启动日志出现 `[kratos] 缺少 KRATOS_PUBLIC_URL 或 PUBLIC_URL，统一账号登录已禁用`：补齐环境变量。
- Kratos 使用私有 CA 时，通过 `NODE_EXTRA_CA_CERTS` 指定证书文件。
- 容器部署时 `KRATOS_PUBLIC_URL` 用 Docker 网络内的服务名（如 `http://kratos:4433`），
  `PUBLIC_URL` / `KRATOS_BROWSER_URL` 用浏览器可访问的外网地址。

## Docker 部署（推荐）

```bash
cp .env.example .env     # 填写 PORT、BOT_TOKEN 等
docker compose up -d --build
docker compose ps
docker compose logs -f ledger
```

数据存放在命名卷 `ledger-data` 中，重建镜像或容器不会丢失。

```bash
docker compose up -d --build     # 更新代码后重新构建并启动
docker compose restart           # 重启
docker compose down              # 停止，保留数据
docker compose down -v           # ⚠️ 停止并删除数据卷（会清空账目）
```

如果从旧版本迁移后日志出现 `/app/data` 权限错误，修正数据卷属主：

```bash
docker run --rm --user root -v ledger-data:/data association-ledger:latest \
  chown -R 1000:1000 /data
```

备份/恢复数据卷：

```bash
# 备份到当前目录
docker run --rm -v ledger-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/ledger-data.tar.gz -C /data .

# 恢复
docker run --rm -v ledger-data:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/ledger-data.tar.gz -C /data"
```

容器内已经做了这些限制：

- 以 uid/gid `1000` 的非 root 用户运行
- 根文件系统只读，只有 `/app/data` 数据卷和 `/tmp` 可写
- 丢弃全部 Linux capability，开启 `no-new-privileges`
- `.env` 只在运行时注入，不进入镜像

如果前面有宿主机 nginx/caddy，在 `.env` 中加 `BIND_IP=127.0.0.1`，只暴露给本机，
再由反向代理提供 HTTPS：

```nginx
server {
    listen 80;
    server_name ledger.example.com;
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Docker 与宿主机共享内核，不是绝对的安全边界；不要使用 `privileged`、不要挂载
Docker socket，保持 Docker 本身更新即可。

> 服务器无法访问 Docker Hub 时，请先为 Docker 配置镜像加速器，或在能访问的机器上
> 构建好镜像后导出（`docker save` / `docker load`）。

## 部署为单文件程序（Debian 13）

用 Bun 把后端编译成一个可直接执行的文件。前端文件、`.env`、PDF 预览资源和数据目录
都放在二进制文件旁边。构建脚本可在 Windows/macOS/Linux 上运行，支持交叉编译。

```bash
npm install
npm run build:binary          # 默认 linux-x64；ARM 服务器用 build:binary:linux-arm64
```

构建产物在 `dist/linux-x64/`：

```
dist/linux-x64/
├── ledger          # 单文件可执行程序
├── index.html      # 前端页面
├── app.js          # 前端脚本
├── .env.example
├── vendor/         # PDF 预览依赖（pdf.js）
└── data/           # 首次运行后生成：SQLite 数据库和凭据文件
```

部署：

```bash
scp -r dist/linux-x64 user@server:/opt/ledger
ssh user@server
cd /opt/ledger
chmod +x ledger
cp .env.example .env    # 填写 PORT、BOT_* 等
./ledger
```

默认数据写入二进制旁边的 `data/`。若该目录不可写（例如以 systemd 服务运行），在
`.env` 中设置 `LEDGER_DATA_DIR=/var/lib/ledger`，并确保运行用户有写权限。

systemd 示例（`/etc/systemd/system/ledger.service`）：

```ini
[Unit]
Description=Association ledger
After=network.target

[Service]
WorkingDirectory=/opt/ledger
ExecStart=/opt/ledger/ledger
Restart=on-failure
User=ledger

[Install]
WantedBy=multi-user.target
```

说明：Bun 的 `--compile` 会捆绑 Node 内置模块（本项目使用 `node:sqlite`），构建机与
目标机都不需要安装 Node.js。
