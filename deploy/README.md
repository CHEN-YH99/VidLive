# Docker 生产部署说明

本目录包含 VidLive 的基础 Docker 生产部署配置。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `docker-compose.prod.yml` | 生产 Compose 编排，包含 PostgreSQL、Redis、迁移任务、后端 API、Next.js 前端和网关 Nginx |
| `.env.docker.example` | Docker 生产环境变量模板 |
| `deploy/docker/backend.Dockerfile` | 后端生产镜像 |
| `deploy/docker/web.Dockerfile` | Next.js 前端生产镜像，执行 `next build` 后用 `next start` 运行 |
| `deploy/nginx/default.conf` | 网关 Nginx 配置，将 `/api` 反代到后端，将其他请求反代到 Next.js 前端 |
| `.dockerignore` | 减少 Docker 构建上下文，避免把依赖、构建产物和密钥打进镜像 |

## 本机或服务器首次启动

在项目根目录执行：

```bash
cp .env.docker.example .env.production
```

Windows 用 PowerShell：

```powershell
Copy-Item .env.docker.example .env.production
```

修改 `.env.production`：

```env
POSTGRES_PASSWORD=换成强密码
DATABASE_URL=postgresql://postgres:同一个强密码@postgres:5432/video_prompt?schema=public
JWT_SECRET=换成足够长的随机密钥
CORS_ORIGIN=https://你的域名
AUTH_COOKIE_SECURE=true
NEXT_PUBLIC_API_BASE_URL=/api
```

本地测试时可以先保留：

```env
CORS_ORIGIN=http://localhost:8000
AUTH_COOKIE_SECURE=false
```

如果暂时只用服务器 IP 测试，把 `CORS_ORIGIN` 改成：

```env
CORS_ORIGIN=http://服务器IP:8000
AUTH_COOKIE_SECURE=false
```

如果启用 Resend 或 SMTP 发验证码，需要在 `.env.production` 填写对应密钥；如果不填，生产环境不会把验证码打印到日志，用户就收不到验证码。

如果启用 Cloudflare R2 或兼容 S3 的对象存储，填写：

```env
R2_ENDPOINT=https://你的账号.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=...
```

不填写也能跑，导出包会保存在 `backend_uploads` Docker 卷里。

启动：

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Windows PowerShell 同样执行：

```powershell
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

查看状态：

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production ps
```

查看日志：

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f backend
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f web
```

访问：

```text
http://localhost:8000
```

站点健康检查：

```bash
curl http://127.0.0.1:8000/api/health
```

后端直连健康检查：

```bash
curl http://127.0.0.1:3010/api/health
```

Windows PowerShell 如果 `curl` 被映射成 `Invoke-WebRequest` 后输出不好看，可以用：

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/api/health | Select-Object -ExpandProperty Content
```

如果你在服务器上用 `curl http://127.0.0.1:8000/api/health` 能看到 `{"status":"ok"}`，但公网打不开，优先检查防火墙、安全组、域名解析和外层反代。先别急着改代码，代码背这个锅就很冤。

## Windows 部署准备

Windows 本机或 Windows 服务器也能跑这套 Compose，但要注意它跑的是 Linux 容器：

1. 安装 Docker Desktop。
2. Docker Desktop 设置里启用 WSL 2 backend。
3. Docker Desktop 切到 `Linux containers`，不要用 `Windows containers`。
4. 确认 Docker 可用：

```powershell
docker --version
docker compose version
```

5. 如果提示 WSL 缺失，在管理员 PowerShell 执行：

```powershell
wsl --install
```

安装完成后重启电脑，再打开 Docker Desktop。

6. 如果 Windows 防火墙拦截访问，需要放行 `WEB_PORT`，默认是 `8000`。

Windows 只适合本机验证或轻量服务器部署。正式生产更推荐 Linux 服务器，少很多 Docker Desktop、登录会话、自动启动和防火墙层面的幺蛾子。不是 Windows 不能用，是它上线跑容器确实更会搞事情。

### Docker Desktop 没有托盘图标或连不上 Engine

如果系统托盘右下角没有 Docker 图标，先从开始菜单搜索并打开 `Docker Desktop`，等到界面显示 Docker Engine 已启动。任务栏可能会把图标收到 `^` 隐藏图标里。

如果执行 `docker version` 只有 `Client`，没有 `Server`，或者提示：

```text
permission denied while trying to connect to the docker API
```

按下面顺序处理：

1. 退出 Docker Desktop，再从开始菜单重新打开。
2. 如果仍然不行，用管理员 PowerShell 执行：

```powershell
Start-Service com.docker.service
```

3. 如果提示没有权限，把当前 Windows 用户加入 `docker-users`：

```powershell
net localgroup docker-users "$env:USERNAME" /add
```

4. 注销 Windows 用户，重新登录，再打开 Docker Desktop。
5. 再次验证：

```powershell
docker version
docker compose version
```

只有看到 `docker version` 输出里同时存在 `Client` 和 `Server`，才能继续执行 Compose 部署。

## 上线前需要你准备

这些东西不在仓库里，我没法替你凭空变出来：

- 服务器 SSH 权限，或者能执行 Docker Compose 的面板权限。
- 域名和 DNS 解析。如果没有域名，只能先用 `http://服务器IP:8000` 测。
- HTTPS 证书。正式登录 Cookie 建议配 HTTPS 后再把 `AUTH_COOKIE_SECURE=true`。
- 新的生产密钥：`POSTGRES_PASSWORD`、`JWT_SECRET`、邮件服务密钥。
- 邮件服务配置：Resend API Key、已验证发件域名/发件地址，或 SMTP 账号。
- 可选对象存储：Cloudflare R2 或兼容 S3 的 endpoint、bucket、access key。
- 服务器防火墙/安全组放行 80/443，或者临时放行 `WEB_PORT`。
- 如果要验证完整 iOS Live Photo MakerNote 链路，还需要 iPhone 原生实况照片导出的模板静态图。

仓库里我能处理的是 Dockerfile、Compose、Nginx、环境变量模板、部署文档和本地构建校验；真实账号、域名、密钥、服务器控制台这些必须你配合。这个不是甩锅，是物理上我没你银行卡和服务器密码。

## 更新发布

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production ps
```

`migrate` 服务会在后端启动前尝试执行：

```bash
pnpm exec prisma migrate deploy --schema apps/api/prisma/schema.prisma
```

如果项目没有 Prisma schema，会自动跳过迁移。如果存在 schema 但迁移失败，后端不会继续启动。这个设计是故意的，数据库没准备好还强行启动，属于给自己安排夜宵事故。

## 正式域名接入

当前网关 Nginx 默认暴露宿主机端口：

```text
8000 -> gateway:80
```

服务器外层可以用 Nginx / Caddy / 宝塔反向代理到：

```text
http://127.0.0.1:8000
```

接口 `/api/` 已经由网关 Nginx 转发到：

```text
http://backend:8000/api/
```

页面请求会由网关 Nginx 转发到：

```text
http://web:3000
```

因此外层反代只需要代理整个站点到 `127.0.0.1:8000` 即可。

## 常用维护命令

停止：

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production down
```

重启后端：

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production restart backend
```

进入后端容器：

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec backend sh
```

备份数据库：

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec postgres pg_dump -U postgres video_prompt > vidlive_backup.sql
```

## 注意事项

- `.env.production` 不要提交 Git。
- 生产环境务必修改 `POSTGRES_PASSWORD` 和 `JWT_SECRET`。
- `DATABASE_URL` 中的密码要和 `POSTGRES_PASSWORD` 保持一致。
- 容器内部连接数据库使用服务名 `postgres`，连接 Redis 使用服务名 `redis`。
- 如果后端健康检查不是 `/api/health`，需要同步修改 `docker-compose.prod.yml` 中 backend 的 `healthcheck`。
- 当前 Dockerfile 按 `@vidlive/api`、`@vidlive/web`、`@vidlive/shared` 配置；如果包名变化，需要同步修改 `deploy/docker/*.Dockerfile`。
- 当前前端按 Next.js 部署，使用 `next start` 监听 `3000`，不要再按 Vite 的 `dist` 静态目录理解。
