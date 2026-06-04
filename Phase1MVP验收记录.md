# VidLive - Phase 1 MVP 验收记录

## 文档说明

- **版本**：v1.0
- **日期**：2026年6月4日
- **阶段**：Phase 1：MVP 闭环
- **目标**：把无登录导入、裁剪、关键帧、导出和保存指引闭环补成可重复验收记录。

---

## 1. 当前验收状态

> **MVP 手动验收状态**：待执行
>
> 工程侧已补 `pnpm run test`、`pnpm run phase:check` 和 `pnpm run phase:check:strict`。严格模式会在真机、抓包、性能或内测证据缺失时失败，这不是找茬，是防止项目靠感觉上线。

| 验收项 | 当前状态 | 证据/说明 |
| --- | --- | --- |
| 无登录完成导入、裁剪、关键帧选择和导出 | 桌面自动复测部分通过 | `node tmp\dod-cdp-check.mjs`：Chrome Headless 导入 `dod-valid.gif` 后出现导出结果与“下载 ZIP 包”；`dod-valid.mp4` 可导入但本地生成在稳定退出报告中出现“本地转换失败”。仍需真实 Chrome/Edge/Safari 手动下载打开产物，以及 iPhone Safari 复测。 |
| 标准 Live Photo 预设 | 待真机验证 | 需确认导出包能通过保存路径进入 iPhone 相册。 |
| iOS 锁屏壁纸预设 | 待真机验证 | 需确认 1-2 秒 9:16 片段在 iOS 17+ 锁屏播放。 |
| 本地模式不上传素材 | 桌面自动网络日志通过，真机待补 | CDP Network 记录：GIF/MP4 本地导出期间无 `POST/PUT/PATCH/DELETE`，无 `/api/` 请求；证据见 `tmp/dod-cdp-report.json`。仍需 DevTools HAR 或代理抓包、iPhone Safari 记录。 |
| 失败提示有原因和下一步 | 部分通过 | `dod-invalid.txt` 上传后出现“格式不支持”。文件过大、浏览器内存不足、云端超时仍需复测。 |
| 内测用户首次完成导出平均不超过 3 分钟 | 待内测记录 | 至少 3 名内测用户记录首导出耗时。 |

---

## 2. 真机兼容矩阵

| 设备 | iOS 版本 | 浏览器/路径 | 标准预设保存 | 锁屏预设播放 | 失败提示 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| iPhone 1 | 待填 | Safari / 文件 App | 待测 | 待测 | 待测 | 需覆盖 iOS 17+。 |
| iPhone 2 | 待填 | Safari / Shortcuts | 待测 | 待测 | 待测 | 需覆盖另一个主要版本。 |
| iPhone 3 | 待填 | 桌面下载 + AirDrop | 待测 | 待测 | 待测 | 需记录保存路径。 |

---

## 3. 隐私与抓包记录

| 环境 | 操作 | 是否上传原始素材 | 是否上传缩略图 | 证据 |
| --- | --- | --- | --- | --- |
| Chrome 桌面 | 导入并本地导出 10 秒视频 | 待抓包 | 待抓包 | 待补 HAR 或截图。 |
| Chrome Headless | 导入并本地导出 `dod-valid.gif`、`dod-valid.mp4` | 否 | 否 | CDP Network：无变更类请求、无 `/api/` 请求；`tmp/dod-cdp-report.json`。 |
| iPhone Safari | 导入并本地导出短视频 | 待抓包 | 待抓包 | 待补代理或系统日志记录。 |

---

## 4. 性能记录

| 样例 | 环境 | 解析耗时 | 导出耗时 | 总耗时 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 10 秒 1080p MP4 | Chrome 桌面 | 待测 | 待测 | 待测 | 目标 P75 小于 60 秒。 |
| 100MB 内视频 | Chrome 桌面 | 待测 | 待测 | 待测 | 目标 P75 解析小于 10 秒。 |
| 1-2 秒 9:16 MP4 | iPhone Safari | 待测 | 待测 | 待测 | 目标可完成锁屏预设导出。 |

---

## 5. 2026-06-04 自动复测记录

| 检查项 | 命令/证据 | 结果 |
| --- | --- | --- |
| 桌面视口渲染 | Chrome Headless 1440x1000，截图 `tmp/dod-screenshots/desktop-1440x1000.png` | 通过；页面非空白，无横向溢出。 |
| 移动视口渲染 | Chrome Headless 390x844，截图 `tmp/dod-screenshots/mobile-390x844.png` | 通过；页面非空白，无横向溢出。注意：这不是 iPhone Safari 真机。 |
| 本地 GIF 导出路径 | `node tmp\dod-cdp-check.mjs`，样例 `dod-valid.gif` | 通过；出现“导出结果”和“下载 ZIP 包”。 |
| 本地 MP4 导出路径 | `node tmp\dod-cdp-check.mjs`，样例 `dod-valid.mp4` | 不稳定/阻塞；稳定退出的最近一次报告出现“本地转换失败”，此前同环境曾生成 ZIP，需真实浏览器复测 MediaRecorder 稳定性。 |
| 错误路径 | `dod-invalid.txt` | 通过；出现“格式不支持”。 |
| 本地隐私网络日志 | CDP Network | 通过；本地 GIF/MP4 导出期间无变更类请求、无 `/api/` 请求。 |

这组自动复测只能证明桌面 Headless 和模拟移动视口可跑；不能替代 iPhone Safari、相册保存、锁屏播放、真实下载打开和 HAR/代理抓包。别把模拟器截图当真机通行证，阿叔看了都摇头。

---

## 6. 通过口径

只有同时满足下面条件，才把本文档顶部改为 `**MVP 手动验收状态**：通过`：

1. 3 台 iPhone 完成标准预设保存和锁屏预设测试。
2. 桌面和 iPhone Safari 各完成一次无登录完整导出。
3. 本地模式抓包确认不上传原始素材和缩略图。
4. 10 秒 1080p 和 100MB 内样例有性能记录。
5. 至少 3 名内测用户首导出平均耗时不超过 3 分钟。
6. `pnpm run phase:check:strict` 通过。

---

**维护者**：待定
