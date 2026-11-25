# XDSEC 会费账务系统

本系统有以下功能：

- 管账的同学填报收支
- 协会的同学通过协会公号访问系统，查看收支凭据和收支统计
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
