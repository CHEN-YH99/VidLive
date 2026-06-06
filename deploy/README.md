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

修改 `.env.production`：

```env
POSTGRES_PASSWORD=换成强密码
DATABASE_URL=postgresql://postgres:同一个强密码@postgres:5432/video_prompt?schema=public
JWT_SECRET=换成足够长的随机密钥
CORS_ORIGIN=https://你的域名
NEXT_PUBLIC_API_BASE_URL=/api
```

本地测试时可以先保留：

```env
CORS_ORIGIN=http://localhost:8000
```

启动：

```bash
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

后端本机健康检查：

```bash
curl http://127.0.0.1:3010/api/health
```

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
http://backend:3010/api/
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
