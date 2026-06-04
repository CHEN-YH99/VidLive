# VidLive - Phase 3 V1.0 正式版验收记录

## 文档说明

- **版本**：v1.0
- **日期**：2026年6月4日
- **阶段**：Phase 3：V1.0 正式版
- **目标**：补齐用户系统、配额、AI 关键帧、基础编辑、兼容反馈、监控摘要和上线准备检查。

---

## 1. 当前验收状态

> **V1.0 手动验收状态**：待执行
>
> 工程侧已补 V1 API、编辑生效链路、AI 关键帧候选、兼容反馈和上线检查端点。当前用户/配额/反馈/指标服务为 in-memory V1 验证实现；`apps/api/prisma/schema.prisma` 已有正式数据模型，但 Prisma client、迁移执行、生产数据库和错误追踪还没真正接上。讲白点：接口和行为补了，生产持久化别装作已经有。

| 模块 | 当前状态 | 证据/说明 |
| --- | --- | --- |
| 用户系统 | 已实现，待实测 | `POST /api/v1/auth/register`、`POST /api/v1/auth/login`、`GET /api/v1/me`。 |
| 配额系统 | 已实现，待实测 | `GET /api/v1/usage`、`POST /api/v1/usage/conversions`，免费每日 5 次。 |
| 数据库 | Schema 已有，持久化待接入 | Prisma schema 包含 users、conversions、usage_logs；当前 API 使用内存存储。 |
| AI 关键帧 | 已实现 heuristic-v1，待人工评估 | `POST /api/v1/keyframes/recommendations` 返回 Top 3 候选。 |
| 基础编辑 | 已实现，待导出复测 | 旋转、翻转、亮度、对比度、饱和度进入本地 Canvas 和云端 FFmpeg。 |
| 兼容面板 | 已实现，待实测 | `POST /api/v1/compatibility-feedback` 和 summary API。 |
| 监控摘要 | 已实现，待日志/告警接入 | `GET /api/v1/metrics/summary` 返回用户、用量、兼容反馈和成功率摘要。 |
| 上线准备 | 已实现检查端点，待整改 | `GET /api/v1/launch-readiness` 标记 JWT_SECRET、数据库、错误追踪状态。 |

---

## 2. V1.0 API 验收矩阵

| 场景 | 操作 | 期望 | 结果 |
| --- | --- | --- | --- |
| 注册 | 使用 email、username、8 位以上密码 | 返回用户资料和 token | 待测 |
| 登录 | 使用注册邮箱和密码 | 返回 token | 待测 |
| 用户资料 | Bearer token 调 `/api/v1/me` | 返回用户和用量 | 待测 |
| 配额消耗 | 连续调用 usage conversion | 第 6 次返回 429 | 待测 |
| AI 推荐 | 提交视频元信息 | 返回 3 个候选关键帧 | 待测 |
| 兼容反馈 | 提交保存/锁屏结果 | summary 统计更新 | 待测 |
| 监控摘要 | 查询 metrics summary | 返回成功率和计数 | 待测 |
| 上线检查 | 查询 launch readiness | 默认 secret/数据库/错误追踪给 warn | 待测 |

---

## 3. 基础编辑复测

| 参数 | 本地导出 | 云端导出 | 结果 |
| --- | --- | --- | --- |
| 旋转 90/180/270 | 待测 | 待测 | 待补截图或样例。 |
| 水平/垂直翻转 | 待测 | 待测 | 待补截图或样例。 |
| 亮度/对比度/饱和度 | 待测 | 待测 | 待补截图或样例。 |

---

## 4. 通过口径

只有同时满足下面条件，才把本文档顶部改为 `**V1.0 手动验收状态**：通过`：

1. 注册、登录、Bearer token、用户资料查询全部通过。
2. 免费每日配额可准确限制，第 6 次有明确超额提示。
3. AI Top 3 候选关键帧人工评估准确率大于等于 70%。
4. 基础编辑参数对本地和云端导出结果生效。
5. 兼容反馈可以形成保存成功率和锁屏播放率统计。
6. 监控摘要、错误原因和上线检查可以定位问题。
7. 生产数据库、JWT_SECRET、HTTPS、错误追踪和部署流水线补齐。
8. `pnpm run phase:check:strict` 通过。

---

**维护者**：待定
