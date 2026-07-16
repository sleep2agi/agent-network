# 版本集中管理（整体版本 ⇄ 各 npm 包版本）

**整体版本**（bundle 版本，`v0.X.Y`，即 GitHub release tag）是产品迭代的**唯一管理单位**。
每个整体版本 = 一组**精确锁定**的 npm 包版本（发布时 PINNED 链必须一致）。
每个整体版本一个目录：`docs/version/<整体版本>/plan.md`（范围冻结的功能清单 + 门禁 + DoD）。

## 版本矩阵

| 整体版本 | 状态 | agent-network | agent-node | commhub-server | dashboard | 规划 |
|---|---|---|---|---|---|---|
| **v0.10.15** | 当前 stable | 2.2.21 | 2.4.13 | 0.8.8 | 0.6.0 | —（已发布） |
| **v0.10.16** | 热修·筹备 | 2.2.22（待发） | 2.4.13 | 0.8.8 | 0.6.0 | [plan](./0.10.16/plan.md) |
| **v0.11.0** | 迭代中（preview 线） | 2.3.0（现 preview.33+） | 2.5.0（现 preview.25+） | 0.9.0（现 preview） | 0.7.0（现 0.6.3-preview） | [plan](./0.11.0/plan.md) |

## 规则

1. **新功能只进"迭代中"的整体版本**，其 plan.md 范围冻结后不再加（新想法 → 下一个整体版本的 candidate 标签）。
2. **热修版本只带单一修复**，绝不夹带功能。
3. 发布时整体版本 tag ↔ 各包版本的映射**必须回填到上表**，且与 CLI 内 PINNED 链一致（`anet -v` 可验）。
4. 各包日常可发 preview 小版本，但**对外口径一律用整体版本**说话。
5. 版本号**怎么读**见 [versioning](../../docs-site/docs/guide/versioning.md)；通道状态见 [release-plan](../plans/release-plan.md)。
