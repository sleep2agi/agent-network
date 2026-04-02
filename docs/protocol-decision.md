# 协议选型结论：MCP vs A2A vs ACP

> 日期: 2026-04-02
> 结论: 纯 MCP，现在就能跑。A2A 关注但不投入。

---

## 一句话结论

**用 MCP。现在就能跑，Claude Code 和 Codex 原生支持，零适配成本。**

A2A 和 ACP 解决的是"Agent 如何发现和协作"的问题，但我们的 30 个 Session 都是自己的、都知道 Commander 地址，不需要"发现"。

---

## 三个协议干什么的

| 协议 | 一句话 | 提出者 | 我们需要吗 |
|------|--------|--------|-----------|
| **MCP** | LLM 调外部工具 | Anthropic | **需要，正在用** |
| **A2A** | Agent 互相发现、派任务 | Google | 暂不需要（Session 都是自己的） |
| **ACP** | 多 Agent 编排工作流 | BeeAI/IBM | 不需要（太早期） |

## 为什么不用 A2A

A2A 的核心价值是 **Agent Card**（`/.well-known/agent.json`）做能力发现——适合"开放生态中不认识的 Agent 互相找到对方"。

但我们的场景：
- 30 个 Session 都是自己部署的
- 都连同一个 Commander Server
- 地址写死在 `settings.json` 里
- 不需要"发现"

A2A 的 Task 生命周期（submitted→working→completed）确实比我们自建的好，但引入 A2A 意味着：
- Claude Code 没有原生 A2A 客户端（需要自建适配层）
- Codex 也没有
- 多一层协议 = 多一层 debug

**等 Claude Code 原生支持 A2A 时再考虑。**

## 为什么不用 ACP

- 生态太早期（BeeAI 框架内部）
- 社区比 A2A 小一个数量级
- 解决的问题和 Commander MCP 高度重叠
- 无任何现有工具链集成

## 架构定论

```
┌─────────────────────────────────┐
│  Commander MCP Server (Bun)     │  ← 我们自己写
│  MCP SSE + HTTP REST            │
│  SQLite (sessions/inbox/results)│
└───────────────┬─────────────────┘
                │ 30 条 MCP SSE 连接
    ┌───────────┼───────────┐
    │           │           │
 Claude Code  Claude Code  Codex
 (原生 MCP)   (原生 MCP)   (原生 MCP)
```

就这样。不需要 A2A，不需要 ACP，不需要适配层。MCP 一把梭。
