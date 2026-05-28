# 案例与 Demo

这里是 Agent Network 的可运行案例入口。案例只保留当前仓库有明确 CLI、`demos/` 目录或 Docker 测试覆盖的内容；没有可验证路径的手工案例已下线，避免文档领先于代码。

## 已验证案例

| 案例 | 运行方式 | Agent 数量 | 验证方式 | 亮点 |
|------|----------|:---------:|----------|------|
| 辩论赛 Demo | `anet demo debate` | 6 | Docker test27 校验 CLI help/list + 文档构建 | 内置 9 步辩论编排，自动独立 network |
| 你好世界 | `demos/hello-world` | 2 | Docker Compose 资产 + Docker test27 文档校验 | 最简单的两个 Agent 对话 |
| 翻译流水线 | `demos/translation-pipeline` | 3 | Docker Compose 资产 + Docker test27 文档校验 | 中→英→日链式翻译 |
| 军团编队 | `demos/codex-telegram-squad` | 11 | Docker test23/test24 通信流 + test27 文档校验 | 1 指挥 + 10 Worker，Telegram/Dashboard |

## 已下线案例

`代码审查`、`成语接龙`、`混合模型协作` 暂时从导航和站点中删除。它们之前只有手工步骤，没有独立 Docker demo 或稳定自动化验证；等补齐 `demos/` 资产和测试后再重新上线。

::: tip 运行案例前
先完成 [上手指南](/guide/getting-started)，并准备对应模型 API Key。需要 Docker 的案例请在仓库根目录或对应 `demos/` 子目录运行。
:::
