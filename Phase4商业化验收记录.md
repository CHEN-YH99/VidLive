# VidLive - Phase 4 商业化验证记录

## 文档说明

- **版本**：v1.0
- **日期**：2026年6月4日
- **阶段**：Phase 4：商业化验证
- **目标**：验证 Pro 计划、升级路径、批量、4K、历史记录、运营摘要和 A/B 实验是否值得继续投入。

---

## 1. 当前验收状态

> **商业化手动验收状态**：待执行
>
> 工程侧已补 Free/Pro 计划、mock checkout intent、Pro 升级/取消、批量、4K 权限、历史记录、运营摘要和 A/B 分流。当前支付 provider 是 `mock-stripe`，不能当真实收款、续费、退款能力。真扣款没接就别讲商业化已经跑通，钱不会听你吹。

| 模块 | 当前状态 | 证据/说明 |
| --- | --- | --- |
| 订阅计划 | 已实现，待实测 | `GET /api/v1/billing/plans` 返回 Free/Pro 权益。 |
| 支付接入 | mock 已实现，真实 Stripe 待接入 | checkout intent 和 confirm 可跑通，但不真实扣款。 |
| 取消订阅 | 已实现，待实测 | `POST /api/v1/billing/subscription/cancel` 回退 Free。 |
| 批量处理 | 已实现权限验证，待实测 | Pro 用户可创建批量；Free 用户应被阻断。 |
| 4K 输出 | 已实现 Pro 权限入口，待实测 | `outputQuality: "4k"` 需要 Pro。 |
| 历史记录 | 已实现，待实测 | `GET /api/v1/history` 返回 usage、batches、checkouts。 |
| 运营后台 | 已实现摘要，待实测 | `GET /api/v1/admin/commercial-summary`。 |
| A/B 实验 | 已实现，待实测 | `GET /api/v1/experiments/pro-cta` 返回 control/pro-benefits。 |

---

## 2. 商业化验收矩阵

| 场景 | 操作 | 期望 | 结果 |
| --- | --- | --- | --- |
| Free 权限 | Free 用户创建批量 | 返回 Pro required | 待测 |
| Checkout | 登录用户创建 checkout intent | 返回 mock-stripe intent | 待测 |
| 升级 Pro | confirm checkout | 用户 planType 变为 pro，quota 变 100 | 待测 |
| Pro 批量 | Pro 用户创建 3 文件批量 4K | 返回 completed batch | 待测 |
| 历史记录 | 查询 history | 包含 checkout 和 batch | 待测 |
| 取消订阅 | cancel subscription | 用户回到 free，quota 变 5 | 待测 |
| 运营摘要 | 查询 commercial summary | 看到用户、Pro、checkout、batch 指标 | 待测 |
| A/B 实验 | visitorId 查询 | 稳定返回同一 variant | 待测 |

---

## 3. 通过口径

只有同时满足下面条件，才把本文档顶部改为 `**商业化手动验收状态**：通过`：

1. Free/Pro 权益边界在 UI 和 API 中一致。
2. 支付、续费、取消订阅、退款路径接入真实 provider 并跑通。
3. Free 用户无法使用批量和 4K；Pro 用户可以使用。
4. 批量任务单个失败不影响整批记录。
5. 历史记录可重新查看和删除。
6. 运营摘要能看到转化、失败率、批量和成本指标。
7. A/B 实验形成可比较的 Pro 入口数据。
8. 免费转付费达到 5%，或明确低于目标的原因。
9. `pnpm run phase:check:strict` 通过。

---

**维护者**：待定
