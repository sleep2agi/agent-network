# 案例与 Demo

这里是 Agent Network 的可运行案例入口。案例只保留当前仓库有明确 CLI、`demos/` 目录或 Docker 测试覆盖的内容；没有可验证路径的手工案例已下线，避免文档领先于代码。

## 已验证案例

| 案例 | 运行方式 | Agent 数量 | 验证方式 | 亮点 |
|------|----------|:---------:|----------|------|
| [辩论赛 Demo](/cases/debate) | `anet demo debate` | 6 | Docker test27 校验 CLI help/list + 文档构建 | 内置 9 步辩论编排，自动独立 network |
| [PR 审查室](/cases/pr-review-room) | `anet demo pr-review` | 4 | Docker test28 smoke + assertions.json 结构断言 | 3 reviewer 并行扇出 + barrier + judge 合并，输出可贴 GitHub 的 markdown 评论 |
| [你好世界](/cases/hello-world) | `demos/hello-world` | 2 | Docker Compose 资产 + Docker test27 文档校验 | 最简单的两个 Agent 对话 |
| [翻译流水线](/cases/translation-pipeline) | `demos/translation-pipeline` | 3 | Docker Compose 资产 + Docker test27 文档校验 | 中→英→日链式翻译 |
| [军团编队](/cases/telegram-squad) | `demos/codex-telegram-squad` | 11 | Docker test23/test24 通信流 + test27 文档校验 | 1 指挥 + 10 Worker，Telegram/Dashboard |
| [Telegram 接入已有节点](/cases/telegram-bind-claude-code-cli) | `anet channel add telegram <node> ...` | 1 (channel 加到现有 node) | 手工 walkthrough（claude-code-cli runtime；RFC-002 Phase 1 排队） | DM bot → Claude Code 全能力（bash / 改文件 / MCP）|

::: info 还没进表的内置 demo（cases doc 待补）
- `anet demo socialmedia` — 4-agent 社媒内容工厂（选题/文案/配图/审核），~3 min
- `anet demo sci-team` — 科研军团：1 leader + N-1 worker（默认 10，5-50 可调）跑书生模型，Phase 1 scaffold

跑 `anet demo <name> --help` 看用法；cases 详版正在补稿。
:::

## 已下线案例

`成语接龙`、`混合模型协作` 暂时从导航和站点中删除。它们之前只有手工步骤，没有独立 Docker demo 或稳定自动化验证；等补齐 `demos/` 资产和测试后再重新上线。

> `代码审查` 已于 2026-05-13 以 [PR 审查室](/cases/pr-review-room) 的形式恢复上线 — 现在是 4 agent CLI demo + 完整 Docker 测试覆盖。

::: tip 运行案例前
先完成 [上手指南](/guide/getting-started)，并准备对应模型 API Key。需要 Docker 的案例请在仓库根目录或对应 `demos/` 子目录运行。
:::

## 下一步

**完成第一个 demo 后**：
- [多模型配置](/guide/multi-model) — 换 DeepSeek / Kimi / Claude 等
- [Dashboard](/guide/dashboard) — 在 Web UI 看刚刚跑的 demo 数据流
- [架构概览](/guide/architecture) — 理解 demo 背后 Hub / agent / runtime 怎么协作

**生产化**：
- [Docker 部署](/deploy/docker) — 把 demo 容器化部署到服务器
- [生产部署](/deploy/production) — TLS / 反向代理 / 备份完整 checklist

**改造和扩展**：
- [Channel 插件](/guide/channels) — 把 demo 接入 Telegram / 微信 / 飞书
- [Agent Node 配置](/guide/agent-node) — 自己写 agent 的完整字段说明
- [CLI 命令](/guide/cli) — 命令总览 + 逐命令详细用法
