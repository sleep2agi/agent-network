---
title: v0.8.0 文档归档
---

# 📦 Agent Network — v0.8.0 文档归档

::: warning 你正在查看历史归档版本
本目录是 git tag [`v0.8.0`](https://github.com/sleep2agi/agent-network/releases/tag/v0.8.0) 时刻的文档快照（2026-05-11 首发）。**当前最新是 v0.8.2**（2026-05-12 通过 npm `latest` tag 发布；中间还经过了 v0.8.1 补丁），见[更新日志](/changelog)，建议[回到最新文档](/)。

仅在你确实需要查阅 v0.8.0 时使用本归档（例如：你的环境固定锁定在 v0.8.0、与本版同步排查问题）。
:::

## v0.8.0 当时的内容

按章节快速跳转（本归档版本）：

- [**上手指南**](./guide/getting-started)
- [**架构概览**](./guide/architecture)
- [**CLI 命令**](./guide/cli)
- [**Dashboard**](./guide/dashboard)
- [**Token 体系**](./concepts/tokens)
- [**角色与权限**](./concepts/roles)
- [**安全设计**](./concepts/security)
- [**Docker 部署**](./deploy/docker)
- [**生产部署**](./deploy/production)
- [**API 参考**](./api/mcp-tools)
- [**FAQ**](./faq)
- [**故障排查**](./troubleshooting)

## v0.8.0 vs 当前 latest 主要差异

| 项 | v0.8.0 (本归档) | v0.8.1 (补丁) | v0.8.2 (latest) |
|---|---|---|---|
| Dashboard | 0.4.1 | **0.4.2**（修 /nodes /admin SSE-online bug） | 0.4.2 |
| CLI | 2.1.4 | 2.1.5（PINNED_DASHBOARD bump） | **2.1.7**（telegram one-shot + claude-code-cli session resume 修复） |
| commhub-server | 0.8.0 | 0.8.0 | 0.8.0 |
| agent-node | 2.3.0 | 2.3.0 | 2.3.0 |

完整 diff 见 [更新日志](/changelog)。

## 我应该用哪个版本？

- ✅ **新项目** / 升级现有项目：用 **v0.8.2 latest**（[回到最新文档](/)）
- 📦 **环境锁定 v0.8.0**：本归档可作为参考；建议升到 v0.8.2（dashboard SSE 显示 bug 在 v0.8.1 修, claude-code-cli session resume + telegram one-shot 在 v0.8.2 加）
- 🕰 **历史溯源**：本归档是 v0.8.0 tag 时刻的精确文档快照
