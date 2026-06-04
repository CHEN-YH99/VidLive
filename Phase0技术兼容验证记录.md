# VidLive - Phase 0 技术与兼容验证记录

## 文档说明

- **版本**：v1.0
- **日期**：2026年6月3日
- **阶段**：Phase 0：技术与兼容验证
- **目标**：验证 Live Photo 生成、保存路径、锁屏兼容、本地处理和云端兜底的关键风险。

---

## 1. 当前实现产物

### 后端 POC 服务

已新增 Phase 0 验证 API：

| 接口 | 用途 |
| --- | --- |
| `GET /api/phase0/environment` | 探测 FFmpeg、ffprobe、exiftool 是否可用。 |
| `GET /api/phase0/checklist` | 返回 Phase 0 模块、保存路径、退出标准和预设清单。 |
| `POST /api/phase0/live-photo-poc` | 上传单个 MP4/MOV，生成 `photo.jpg`、`video.mov`、`manifest.json`、`README.txt` 和 ZIP。 |

### 服务实现

| 文件 | 说明 |
| --- | --- |
| `apps/api/src/services/ffmpeg/ffmpeg.service.ts` | 实现 `ffprobe` 元信息读取、关键帧 JPEG 抓取、MOV 裁剪转码。 |
| `apps/api/src/services/live-photo/live-photo.service.ts` | 实现 Phase 0 Live Photo POC 包生成；exiftool 可用时注入元数据，不可用时返回 warning。 |
| `apps/api/src/services/live-photo/zip-writer.ts` | 无第三方依赖的 ZIP store 打包器。 |
| `apps/api/src/modules/phase0/phase0.routes.ts` | Phase 0 验证 API。 |

---

## 2. 本机环境探测

| 工具 | 当前状态 | 说明 |
| --- | --- | --- |
| FFmpeg | 可用 | 当前检测到 `ffmpeg version 8.1-essentials_build-www.gyan.dev`。 |
| ffprobe | 可用 | 当前检测到 `ffprobe version 8.1-essentials_build-www.gyan.dev`。 |
| exiftool | 不可用 | 当前 Windows 环境未识别 `exiftool` 命令。 |

### 结论

当前环境可以验证：

- 视频元信息读取；
- 视频裁剪；
- MOV 生成；
- 关键帧 JPEG 提取；
- ZIP 打包；
- API 单任务链路。

当前环境不能完整证明：

- Apple Live Photo 元数据注入；
- iPhone Photos 识别为真正 Live Photo；
- iOS 17+ 锁屏动态壁纸播放。

少了 exiftool 就别嘴硬说 Live Photo 兼容性已经完成，讲这种话上线会被现实按住打。

---

## 3. API 使用方式

### 环境探针

```bash
curl http://127.0.0.1:3001/api/phase0/environment
```

### 检查清单

```bash
curl http://127.0.0.1:3001/api/phase0/checklist
```

### 生成 Live Photo POC 包

```bash
curl -F "file=@sample.mp4" "http://127.0.0.1:3001/api/phase0/live-photo-poc?presetId=ios-lock-screen&startSeconds=0&endSeconds=2&keyframeSeconds=1&muted=true"
```

返回结果会包含：

- `photoPath`
- `movPath`
- `zipPath`
- `manifestPath`
- `readmePath`
- `contentId`
- `probe`
- `warnings`

如果 `warnings` 中出现 `exiftool-not-available`，说明 POC 包已生成，但不能作为完整 Live Photo 元数据验证结论。

---

## 4. 手动真机验证矩阵

| 项目 | 设备/环境 | 操作 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| 标准 Live Photo 保存 | iPhone 1 / iOS 17+ | AirDrop ZIP，尝试导入 `photo.jpg + video.mov` | 待测 | 需记录是否被相册识别为 Live Photo。 |
| 标准 Live Photo 保存 | iPhone 2 / iOS 18+ | Shortcuts 导入 | 待测 | 需确认快捷指令路径。 |
| 锁屏动态壁纸 | iPhone 1 / iOS 17+ | 使用 1-2 秒 9:16 POC 包 | 待测 | 记录是否播放。 |
| 锁屏动态壁纸 | iPhone 2 / iOS 18+ | 使用 1-2 秒 9:16 POC 包 | 待测 | 记录 Motion 开关和失败提示。 |
| 桌面下载路径 | macOS Safari / Chrome | 下载 ZIP 后 AirDrop 到 iPhone | 待测 | 验证桌面到手机链路。 |

---

## 5. Phase 0 退出标准

> **Phase 0 手动验收状态**：待执行
>
> 自动化和静态检查入口已补齐：运行 `pnpm run phase:check` 查看当前 Phase Gate；运行 `pnpm run phase:check:strict` 可作为严格验收门。严格模式会在 `exiftool`、真机保存、锁屏播放或抓包证据缺失时失败。别把“能生成 ZIP”当成“iPhone 已认”，这个坑不小，踩下去脚都拔不出来。

| 退出标准 | 当前状态 | 说明 |
| --- | --- | --- |
| Live Photo POC 包可生成 | 已完成 | 后端 API 可生成 JPEG/MOV/ZIP。 |
| FFmpeg/ffprobe 可用 | 已完成 | 本机可用。 |
| exiftool 元数据注入可用 | 阻塞 | 本机未安装 exiftool。 |
| 至少一条 iPhone 保存路径跑通 | 待真机验证 | 需要 iPhone 和 AirDrop/Shortcuts。 |
| 锁屏播放有真机记录 | 待真机验证 | 需要 iOS 17+ 真机。 |
| 本地模式不上传素材 | 待抓包验证 | Phase 1 前端已有本地路径，仍需抓包记录。 |
| 云端兜底单任务链路 | 部分完成 | Fastify + FFmpeg 单任务 POC 已具备，R2/队列仍属 Beta。 |

---

## 6. 技术决策记录

### ADR-001：MVP 继续采用本地优先，云端作为兜底

- **状态**：暂定通过
- **原因**：用户需求文档明确要求小文件不上传；Phase 1 已实现本地导出闭环。
- **影响**：云端 API 不作为默认路径，只用于大文件、编码不支持、本地失败。

### ADR-002：Phase 0 POC 使用 FFmpeg 生成 MOV/JPEG，exiftool 作为元数据验证依赖

- **状态**：通过，但当前环境阻塞完整验证
- **原因**：FFmpeg 可稳定处理视频，exiftool 是 Live Photo 元数据注入的关键外部依赖。
- **影响**：没有 exiftool 的环境只能验证视频处理，不能宣称 Live Photo 识别完成。

### ADR-003：ZIP 包是验证交付物，不等同于最终用户保存方案

- **状态**：通过
- **原因**：ZIP 方便汇总 `photo.jpg`、`video.mov`、manifest 和 README，但 iPhone 保存仍需 AirDrop/Shortcuts/相册路径验证。
- **影响**：导出页必须继续展示保存路径和兼容提示。

---

## 7. 下一步

1. 安装 exiftool 并重新运行 `/api/phase0/environment`。
2. 准备 1 个 2 秒竖屏 MP4 和 1 个 3 秒普通 MP4。
3. 用 `/api/phase0/live-photo-poc` 生成标准预设和锁屏预设 ZIP。
4. 使用至少 3 台 iPhone 做保存和锁屏测试。
5. 把结果补入本文件的真机验证矩阵。
6. 根据真机结果更新 `技术实现文档.md` 的 Live Photo 元数据和保存路径方案。

### 7.1 自动化补齐项

| 命令 | 用途 | 通过口径 |
| --- | --- | --- |
| `pnpm run test` | 运行 Node 内置测试，确认 Phase Gate 检查项稳定存在。 | 测试通过。 |
| `pnpm run phase:check` | 输出 Phase 0/Phase 1 当前完成状态。 | 可看到 PASS/WARN/BLOCKED 明细。 |
| `pnpm run phase:check:strict` | 严格验收门。 | 所有 Phase Gate 均为 PASS 才通过。 |

### 7.2 exiftool 兜底路径

`apps/api/Dockerfile` 已包含 `perl-image-exiftool`，如果本机暂时不装 `exiftool`，可以用 API 容器环境做元数据注入验证。注意：容器里能跑不等于真机已通过，最终仍要把 iPhone 相册识别和锁屏播放结果写回上面的矩阵。

---

**维护者**：待定
