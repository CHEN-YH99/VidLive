# VidLive

VidLive 是一个 Web 优先的视频转 Live Photo 素材工具。项目目标是把短视频、MOV、GIF 处理成适合 iPhone 真机验证的素材包，并逐步打通 iOS Live Photo / 锁屏动态壁纸链路。

当前阶段已经完成 Web 工具页、本地导出、云端任务 API、Docker 版 FFmpeg/ffprobe/exiftool 环境和 iPhone Safari 基础上传下载验证。需要注意：Safari 下载 ZIP 不会自动变成相册里的实况照片，这一步只是生成配对素材包。

## 当前能力

- 本地模式：在浏览器内读取素材、选择预设、裁剪时长、选关键帧并导出素材包。
- 云端模式：上传视频到 Fastify API，生成 `photo.jpg`、`video.mov`、`animated.webp`、`manifest.json`、`README.txt`。
- Web 代理：手机访问 Web 时通过同源 `/api/proxy` 转发到本机 API，避免 iPhone 把 `localhost` 当成自己。
- 真机验证：iPhone 13 Safari 已验证可访问页面、提交云端任务、下载 ZIP。
- 元数据诊断：manifest 会拆分显示 MOV 和照片侧的 Live Photo 元数据写入情况。

## 重要限制

完整 iOS Live Photo 识别不只靠 MOV，还要求照片侧有 Apple 私有 MakerNote 里的 ContentIdentifier。普通 FFmpeg 抽出的 JPEG 没有这个 MakerNote，exiftool 不能凭空创建。

目前典型 manifest 结果可能是：

```json
{
  "metadataInjected": false,
  "metadataInjection": {
    "videoContentIdentifierInjected": true,
    "photoContentIdentifierInjected": false,
    "photoImageUniqueIdInjected": true
  }
}
```

这表示 MOV 标识已经写入，但照片侧还缺 Apple MakerNote。下一步需要使用 iPhone 原生实况照片导出的 `.HEIC/.JPG + .MOV` 原始配对文件做模板，或改走 macOS PhotoKit / Shortcuts 导入链路。别拿微信、QQ、压缩图来测，元数据会被干碎，没救。

## 项目结构

```text
apps/
  web/       Next.js App Router 工具页
  api/       Fastify API 与云端转换任务
packages/
  shared/    共享产品常量和 TypeScript 契约
scripts/     阶段检查、smoke test 和矩阵检查
```

## 环境要求

- Node.js `>=20`
- pnpm `>=10`
- 本地开发建议安装 FFmpeg / ffprobe
- Live Photo 元数据实验需要 exiftool
- Windows 真机局域网测试建议使用 Docker API 容器兜底

## 安装

```bash
pnpm install
```

## 本地开发

分别启动 API 和 Web：

```bash
pnpm run dev:api
pnpm run dev:web
```

默认端口：

- Web: `http://localhost:3000`
- API: `http://localhost:3001`

## Docker API 验证

构建带 FFmpeg/ffprobe/exiftool 的 API 镜像：

```bash
docker build -f apps/api/Dockerfile -t vidlive-api-exiftool-check .
```

启动 API POC 容器：

```bash
docker run -d --name vidlive-api-poc -p 3011:3001 -e API_HOST=0.0.0.0 -e API_PORT=3001 -e UPLOAD_DIR=/tmp/vidlive/uploads vidlive-api-exiftool-check
```

检查环境：

```bash
curl http://127.0.0.1:3011/api/phase0/environment
```

期望看到：

```json
{
  "verdict": {
    "ffmpegReady": true,
    "ffprobeReady": true,
    "metadataReady": true
  }
}
```

## iPhone 真机测试

手机不能访问电脑上的 `localhost:3001`，因为那是 iPhone 自己。推荐手机只访问 Web，由 Web 同源代理转发 API。

生产构建后启动 Web：

```bash
pnpm --filter @vidlive/web run build
```

Windows 可用 `tmp/start-web.cmd` 启动 Web，它会把代理目标指向 `http://127.0.0.1:3011`：

```cmd
tmp\start-web.cmd
```

iPhone 打开：

```text
http://<电脑局域网 IP>:3000/?v=4
```

例如：

```text
http://172.20.10.8:3000/?v=4
```

验证 Web 代理是否打到正确 API：

```text
http://<电脑局域网 IP>:3000/api/proxy/api/phase0/environment
```

## 常用命令

```bash
pnpm run types
pnpm run build
pnpm run test
pnpm run lint
pnpm run phase:check
pnpm run p0:check
pnpm run p1:check
pnpm run p2:check
```

## 导出包内容

云端 ZIP 通常包含：

```text
photo.jpg
video.mov
animated.webp
manifest.json
README.txt
```

`manifest.json` 是判断当前链路是否接近 Live Photo 识别的关键文件。不要只看 ZIP 里有没有 MOV/JPG，重点看 `metadataInjected` 和 `metadataInjection`。

## Git 忽略策略

仓库只保留 `README.md` 作为公开说明。其他本地需求文档、验收记录、日志、pid、上传产物和临时文件都不进入 Git：

```text
*.md
!README*.md
*.log
*.pid
uploads/
tmp/
```

如果某个非 README 文档已经被 Git 跟踪过，仅修改 `.gitignore` 不会让 GitHub 消失，需要先执行 `git rm --cached` 后再提交。

## 当前下一步

1. 从 iPhone 原生实况照片导出未修改原件，拿到 `.HEIC/.JPG + .MOV` 配对文件。
2. 用原生照片里的 Apple MakerNote 作为模板，验证是否能写入生成照片的 ContentIdentifier。
3. 如果模板链路仍不稳定，改走 macOS PhotoKit / Shortcuts 作为正式保存路径。
