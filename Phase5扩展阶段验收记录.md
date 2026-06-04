# VidLive - Phase 5 扩展阶段验收记录

## 文档说明

- **版本**：v1.0
- **日期**：2026年6月4日
- **阶段**：Phase 5：扩展阶段
- **目标**：搭建 Live Photo 工具箱、模板素材库、API 开放平台、桌面/移动端和浏览器插件的生态框架。

---

## 1. 当前验收状态

> **扩展阶段手动验收状态**：待执行
>
> 工程侧已补工具矩阵、模板库、API key、浏览器扩展 manifest、桌面客户端 manifest 和生态摘要。注意：这里是扩展平台骨架，不是 Chrome/Safari 插件已发布、桌面客户端已打包、iOS App 已上架。别把 manifest 当安装包，讲出去会被懂行的人笑。

| 模块 | 当前状态 | 证据/说明 |
| --- | --- | --- |
| Live Photo 工具箱 | 已实现矩阵，部分工具 preview/planned | `GET /api/v1/tools`。 |
| 模板和素材库 | 已实现基础模板 API | `GET /api/v1/templates`。 |
| API 开放平台 | 已实现 API key 创建/列表 | `POST/GET /api/v1/api-keys`。 |
| 浏览器插件 | 已实现 manifest preview | `GET /api/v1/extensions/browser-manifest`。 |
| 桌面客户端 | 已实现 manifest preview | `GET /api/v1/desktop/manifest`。 |
| 生态摘要 | 已实现 | `GET /api/v1/ecosystem/summary`。 |

---

## 2. 扩展验收矩阵

| 场景 | 操作 | 期望 | 结果 |
| --- | --- | --- | --- |
| 工具矩阵 | 查询 tools | 返回 available/preview/planned 工具 | 待测 |
| 模板库 | 查询 templates | 返回锁屏/社交/Pro 模板 | 待测 |
| API key | 登录用户创建 key | 返回 `vl_` prefix | 待测 |
| Preview 工具 intent | Pro 用户创建 tool intent | preview 工具 accepted | 待测 |
| Planned 工具 intent | AI Image Motion intent | 返回 planned | 待测 |
| 浏览器插件 manifest | 查询 manifest | 返回权限和端点 | 待测 |
| 桌面 manifest | 查询 manifest | 返回平台和工作流 | 待测 |
| 生态摘要 | 查询 summary | 返回工具、模板、API key 数 | 待测 |

---

## 3. 通过口径

只有同时满足下面条件，才把本文档顶部改为 `**扩展阶段手动验收状态**：通过`：

1. Live Photo to GIF/MP4、Image to Live Photo、GIF to Live Photo 至少各有一条真实转换样例。
2. API key 能鉴权调用公开 API，并有配额/滥用限制。
3. 模板库能被前端实际应用到导出参数。
4. Chrome/Safari 插件至少一个完成打包和安装测试。
5. 桌面或轻量 iOS App 至少一个完成可安装 Demo。
6. 生态摘要能反映真实 API 使用和模板使用数据。
7. 扩展功能的成本、失败率和投诉率可控。
8. `pnpm run phase:check:strict` 通过。

---

**维护者**：待定
