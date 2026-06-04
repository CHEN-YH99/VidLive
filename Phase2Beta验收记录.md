# VidLive - Phase 2 Beta 产品化验收记录

## 文档说明

- **版本**：v1.0
- **日期**：2026年6月4日
- **阶段**：Phase 2：Beta 产品化
- **目标**：补齐云端兜底、任务状态、临时下载、手动删除、移动端体验、错误诊断和基础可观测性。

---

## 1. 当前验收状态

> **Beta 手动验收状态**：待执行
>
> 工程侧已接入 Beta 云端任务 API 和前端云端任务面板；严格验收仍要求真实上传、状态轮询、下载、删除、过期、移动端和性能记录。别把本地临时链接当 R2 正式能力，Beta 可以先跑通，正式化再上 R2。

| 模块 | 当前状态 | 证据/说明 |
| --- | --- | --- |
| 后端上传 API | 已实现，待实测 | `POST /api/conversions/cloud-jobs` 接收 MP4/MOV/GIF。 |
| 转换任务状态 API | 已实现，待实测 | `GET /api/conversions/cloud-jobs/:jobId` 返回 queued/processing/completed/failed/expired/deleted。 |
| 云端下载 | 已实现，待实测 | `GET /api/conversions/cloud-jobs/:jobId/download` 返回 ZIP。 |
| 手动删除 | 已实现，待实测 | `DELETE /api/conversions/cloud-jobs/:jobId` 删除本地临时文件。 |
| 24 小时过期 | 已实现，待实测 | 通过 `CLOUD_RETENTION_HOURS` 控制，默认 24 小时。 |
| 队列/Worker | Beta 内存队列 | 当前为 in-memory Beta 队列；Redis/BullMQ 留到正式扩容。 |
| 对象存储 | Beta 本地临时链接 | 当前为 local-temp-link；R2 签名链接留到正式存储接入。 |
| 移动端体验 | 已补 sticky 操作入口，待 iPhone 复测 | 云端任务提交、轮询、下载、删除需要 iPhone Safari 实测。 |
| 错误诊断 | 已接基础错误码，待异常样例复测 | 覆盖上传失败、过期链接、云端处理失败。 |
| 基础监控 | 待日志复测 | Fastify/Pino 已有日志，需记录任务状态和失败原因样例。 |

---

## 2. Beta API 验收矩阵

| 场景 | 操作 | 期望 | 结果 |
| --- | --- | --- | --- |
| 小文件云端兜底 | 上传 2-3 秒 MP4 | 返回 202 和 jobId | 待测 |
| 状态轮询 | 查询 jobId | queued -> processing -> completed | 待测 |
| 下载 ZIP | completed 后下载 | 返回 application/zip | 待测 |
| 手动删除 | DELETE jobId | 文件删除，再下载返回 404 | 待测 |
| 过期链接 | 设置短 `CLOUD_RETENTION_HOURS` 后等待 | 状态 expired，下载不可用 | 待测 |
| 超限文件 | 上传超过 500MB | 返回 413 | 待测 |
| 不支持格式 | 上传异常扩展名 | 返回 415 | 待测 |

---

## 3. 移动端和错误复测

| 环境 | 流程 | 期望 | 结果 |
| --- | --- | --- | --- |
| iPhone Safari | 选择云端模式 -> 提交 -> 轮询 -> 下载 | 操作入口不被遮挡，状态清楚 | 待测 |
| Chrome 桌面 | 本地失败后切云端 | 错误提示可定位下一步 | 待测 |
| Edge 桌面 | 云端任务完成后删除 | 删除后链接失效 | 待测 |

---

## 4. 性能与保留策略

| 样例 | 环境 | 上传耗时 | 处理耗时 | 下载耗时 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 30 秒 1080p MP4 | 本地 API | 待测 | 待测 | 待测 | 目标 P75 小于 30 秒，达不到需记录瓶颈。 |
| 100MB 内 MP4 | 本地 API | 待测 | 待测 | 待测 | 验证 Beta 云端兜底体验。 |

---

## 5. 通过口径

只有同时满足下面条件，才把本文档顶部改为 `**Beta 手动验收状态**：通过`：

1. 云端上传、状态查询、下载、删除全部实测通过。
2. 过期链接不可下载，手动删除立即失效。
3. iPhone Safari 可顺畅完成云端任务流程。
4. 上传失败、过期链接、云端处理失败都有用户可读错误。
5. 30 秒 1080p 云端 P75 处理时间有记录。
6. `pnpm run phase:check:strict` 通过。

---

**维护者**：待定
