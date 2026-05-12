# anet 测试矩阵 v0

> 配套 [strategy.md](strategy.md)。每格写「用户视角」的一句话，不是代码视角。
> ✅ 已覆盖 / 🟡 部分 / ❌ 未覆盖（首版基线，后续每轮更新一格）。

## CLI 用户矩阵（persona: 终端开发者）

| ID | 用户故事 | 现状 | 现有覆盖 |
|----|---------|------|---------|
| CLI-01 | 我装好后能起 hub，看到 dashboard | ❌ | （手动） |
| CLI-02 | 我能创建一个 network，拿到 ntok_ | ❌ | （手动） |
| CLI-03 | 我能 `anet node create` 把当前目录注册为节点 | ❌ | （docker-e2e 用 REST 绕过） |
| CLI-04 | 我能 `anet node start` 让 agent 连上 hub | 🟡 | docker-e2e SC03 SSE 上线 |
| CLI-05 | 我中断后 `anet node start` 能恢复同一个 Claude session | ✅ | [report-test31.txt](../tests/report-test31.txt) |
| CLI-06 | 我执行 `anet --new-session` 能强制开新会话 | ✅ | report-test31 L2 |
| CLI-07 | 我用旧版 claude CLI 时 anet 能 fallback 到 --resume | ✅ | report-test31 L3 |

## commhub 矩阵（persona: SDK / integration）

| ID | 用户故事 | 现状 | 现有覆盖 |
|----|---------|------|---------|
| HUB-01 | 没设 admin token 时首次起 hub 自动生成 admin utok 文件 600 | ✅ | [report-test30.txt](../tests/report-test30.txt) |
| HUB-02 | 改密码后老 utok 全部失效 | ✅ | report-test30 |
| HUB-03 | 弱密码（password / 123456）被拒 | ✅ | report-test30 |
| HUB-04 | admin reset-user 撤销目标用户 + 审计落库 | ✅ | report-test30 |
| HUB-05 | utok 注册 → mint ntok → POST /api/tasks → SSE 推送 | ❌ | （核心闭环，**R2 候选**） |
| HUB-06 | utok 被撤销后，它派生的 ntok 立即失效 | ❌ | （**R2 候选**，跟 dual_token 一致性） |
| HUB-07 | SSE 断线后重连不丢消息 | ❌ | （需要时序断言） |
| HUB-08 | task 状态机 pending→completed/failed 落库且 SSE 同步 | 🟡 | docker-e2e SC05（仅 failed） |

## agent-node 矩阵（persona: runtime adapter）

| ID | 用户故事 | 现状 | 现有覆盖 |
|----|---------|------|---------|
| NODE-01 | claude-code-cli runtime 启动 + 注册 | ✅ | docker-e2e SC03 |
| NODE-02 | 收到 inbound task → 回复落 hub（成功路径） | ❌ | （docker-e2e 只测了 failed 路径） |
| NODE-03 | LLM key 错误时 reply.status=failed 写回 hub | ✅ | docker-e2e SC05 |
| NODE-04 | hub 重启后 agent-node SSE 自动重连 | ❌ | （**R3 候选**） |
| NODE-05 | runtime 切换（claude-code → codex / minimax） | ❌ | （v1，先不做） |
| NODE-06 | config.json 缺 session 字段时自动补 UUID | ✅ | report-test31 L0 |

## 优先级（v0 R2 候选）

按 ROI 排序，下一轮选 **HUB-05**（最核心的「闭环」用户故事）：

1. **HUB-05**：register → mint → send → SSE — 是 commhub 的存在理由，必须有保护
2. **HUB-06**：utok 撤销 → ntok 失效 — 安全边界，错了就出事
3. **NODE-04**：hub 重启 SSE 重连 — 真实生产最高频痛点

R2 落地 **HUB-05** 一个；其余进 backlog。
