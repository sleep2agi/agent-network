# Contributing to Agent CommHub

## 文档同步规则（铁律）

**每个 PR/commit 必须包含对应的文档更新，没有文档不合并。**

| 变更类型 | 必须更新的文档 |
|---------|-------------|
| 新功能 | README.md + docs/quickstart.md |
| Bug 修复 | docs/experience.md（踩坑记录） |
| 架构变更 | docs/architecture-decision.md 或相关方案文档 |
| 命名变更 | docs/rename-sop.md（按五步 SOP 执行） |
| 新 Agent 接入 | docs/quickstart.md + docs/orchestration-guide.md |
| 协议/API 变更 | docs/commhub-mcp-design.md |

## 为什么

文档和代码分开维护 = 文档必然过期。一次 commit 同时改代码和文档，才能保持一致。

## Commit 格式

```
feat: 功能描述
docs: 新增/更新了什么文档
fix: 修复描述

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

## 命名规范

Session 别名格式：`站点 + 角色 + 动物`

| 动物 | 模型 |
|------|------|
| 马 🐴 | Claude Code |
| 牛 🐂 | Codex |
| 猫 🐱 | MiniMax |

例：A站运营马 / VL牛 / 大猫
