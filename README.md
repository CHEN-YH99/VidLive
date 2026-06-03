# VidLive

VidLive 是一个 Web 优先的工具，用于把短视频和 GIF 转换为 Live Photo 相关素材。

当前项目骨架遵循产品需求文档和开发周期文档里的 MVP 方向：

- 小文件本地优先处理，无需登录即可开始
- 支持标准 Live Photo 和 iOS 锁屏壁纸两类核心预设
- 明确区分本地处理和云端处理的隐私边界
- 预留 Fastify API 骨架，用于后续接入云端处理兜底能力

## 项目结构

```text
apps/
  web/      Next.js App Router 工具页
  api/      Fastify API 骨架
packages/
  shared/   共享产品常量和 TypeScript 契约
```

## 常用命令

```bash
pnpm install
pnpm run dev:web
pnpm run dev:api
pnpm run types
pnpm run build
```

## MVP 边界

第一阶段重点完成本地素材导入、元信息读取、预设选择、裁剪和关键帧参数、导出保存指引。云端处理、用户系统、R2 存储和 AI 关键帧推荐会放到后续阶段，不在 MVP 一开始就硬塞进来，免得项目刚开工就胖到喘气。
