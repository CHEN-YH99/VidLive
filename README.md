# VidLive

VidLive 是一个 Web 优先的视频转 Live Photo 素材工具。项目目标是把短视频、MOV、GIF 处理成适合 iPhone 真机验证的素材包，并逐步打通 iOS Live Photo / 锁屏动态壁纸链路。

当前阶段已经完成 Web 工具页、本地导出、云端任务 API、Docker 版 FFmpeg/ffprobe/exiftool 环境和 iPhone Safari 基础上传下载验证。需要注意：Safari 下载 ZIP 不会自动变成相册里的实况照片，这一步只是生成配对素材包。

## 当前能力

- 本地模式：在浏览器内读取素材、选择预设、裁剪时长、选关键帧并导出素材包。
- 云端模式：上传视频到 Fastify API，生成 `photo.jpg`、`video.mov`、`animated.webp`、`manifest.json`、`README.txt`。
- Android 实况实验：云端 ZIP 会额外生成 `motion-photo_MP.jpg`，用于 Android Motion Photo 真机测试。
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
    "photoMakerNoteTemplateApplied": false,
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
  ios-importer/  iOS PhotoKit 导入器验证工程
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
- API: `http://localhost:8000`

## Docker API 验证

构建带 FFmpeg/ffprobe/exiftool 的 API 镜像：

```bash
docker build -f apps/api/Dockerfile -t vidlive-api-exiftool-check .
```

启动 API POC 容器：

```bash
docker run -d --name vidlive-api-poc -p 3011:8000 -e API_HOST=0.0.0.0 -e API_PORT=8000 -e UPLOAD_DIR=/tmp/vidlive/uploads vidlive-api-exiftool-check
```

如果已经从 iPhone 原生实况照片拿到静态图模板，可以挂载模板目录并启用照片侧 MakerNote 复制：

```bash
docker run -d --name vidlive-api-poc -p 3011:8000 -e API_HOST=0.0.0.0 -e API_PORT=8000 -e UPLOAD_DIR=/tmp/vidlive/uploads -e LIVE_PHOTO_TEMPLATE_IMAGE_PATH=/tmp/vidlive/reference/IMG_3579.JPG -v ./tmp/iphone-livephoto-reference:/tmp/vidlive/reference:ro vidlive-api-exiftool-check
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

手机不能访问电脑上的 `localhost:8000`，因为那是 iPhone 自己。推荐手机只访问 Web，由 Web 同源代理转发 API。

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
motion-photo_MP.jpg
animated.webp
manifest.json
README.txt
```

`manifest.json` 是判断当前链路是否接近 Live Photo 识别的关键文件。不要只看 ZIP 里有没有 MOV/JPG，重点看 `metadataInjected` 和 `metadataInjection`。

`motion-photo_MP.jpg` 是 Android Motion Photo 实验文件：它是单个 JPEG 文件，内部追加了 MP4 片段，并通过 XMP 标记视频位置。把它复制到 Android 手机后，用 Google Photos 或厂商相册打开，检查是否出现动态照片/实况/动作照片入口。

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

1. 使用 iPhone 原生实况照片静态图作为 MakerNote 模板，生成 `metadataInjected: true` 的 ZIP。
2. 文件 App 基线验证已确认：直接保存 `photo.jpg + video.mov` 会变成普通照片和普通视频，不会自动合成 Live Photo。
3. Android 方向优先验证 `motion-photo_MP.jpg` 是否能被 Google Photos 或厂商相册识别为 Motion Photo。
4. iOS 方向使用 `apps/ios-importer` 的 PhotoKit 导入器，把 `photo.jpg` 作为 `.photo`、`video.mov` 作为 `.pairedVideo` 写入照片库。
