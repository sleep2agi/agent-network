# anet 研发流程 SOP

> 这个文件夹收录 Agent Network 团队的研发流程 SOP。**核心叙事：以 Issue 为中心的 AI-Native 研发迭代流程** —— 所有动作（派任务、ship release、verify、retrospect lessons）都围绕 GitHub Issue 组织。

## 📚 文档清单

| 文档 | 内容 |
|------|------|
| [methodology.md](./methodology.md) | **方法论总览** —— 5 个章节覆盖 Issue-Centric / Release Ops / Verify-First / Agent Dispatch / Retro Lessons，含 v0.9.0/v0.9.1/v0.9.2 三次 release 实战累积数据 |

## 🔑 核心原则

1. **Issue = single source of truth**：每个研发动作必须 → 查 issue / 建 issue / 更新 issue / close issue
2. **Verify-first**：5 件 verifiable artifacts (npm dist-tags / git log / issue评论 / commhub status / pane) 全绿才 ship
3. **完成必 close + 4 要素评论**：版本 / how / who / verify (per [§1.3](./methodology.md#13-完成必-close-评论-4-要素后-close))
4. **Release 走 7 步 SOP**：preview → clean version → 2-phase npm → GitHub Release → docs swap → Vercel deploy → post-promote
5. **每次 P0 / release / incident 必沉淀 lessons**：写 memory / 升级 SOP / cross-link

## 📍 适用范围

- **anet 核心团队**（Tier 1 agents：通信龙 / SDK马 / 工程马 / 测试马 / 文档马 / 通信牛 / N站马 等）
- **贡献者**（Tier 2+ contributors）
- **外部团队**（参考 AI-Native 多 agent 协作方法论）

## 🔗 相关 issues / RFCs

- [Issue #85](https://github.com/sleep2agi/agent-network/issues/85) — AI-Native 研发迭代流程正式文档 tracking
- [Issue #134](https://github.com/sleep2agi/agent-network/issues/134) — lead-level forecast + cost awareness
- [Memory feedback files](https://github.com/sleep2agi/agent-network) — 40+ 个 lessons feedback memory（internal, 通信龙 lead memory）

## ✏️ 维护

- 维护者：通信龙 + 通信工程马
- 更新方式：直接 PR，commit msg 用 `docs(sop): ...`
- 每次 release / P0 incident 之后必触发 retrospective update
