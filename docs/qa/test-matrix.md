# anet 测试矩阵 v0

> 配套 [strategy.md](strategy.md)。**用户视角 + 代码视角两条线都要**：
> - persona 矩阵（CLI / commhub / agent-node / dashboard）= 用户视角 L1+
> - L0 单测补丁清单 = 代码视角
>
> ✅ 已覆盖 / 🟡 部分 / ❌ 未覆盖（首版基线，后续每轮更新一格）。

## CLI 用户矩阵（persona: 终端开发者）

| ID | 用户故事 | 现状 | 现有覆盖 |
|----|---------|------|---------|
| CLI-01 | 我装好后能起 hub，看到 dashboard | ✅ | [qa-cli-01](../../tests/qa-cli-01-hub-start/) R18 PASS（~10s）— banner + /health + admin-utok 600 + 实际 auth + 幂等 re-run |
| CLI-02 | 我能创建一个 network，拿到 ntok_ | ✅ | [qa-cli-02](../../tests/qa-cli-02-network-create/) R13 PASS（~14s）— login + config + create + ls + dup-reject + whoami |
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
| HUB-05 | utok 注册 → mint ntok → report_status → POST /api/tasks → SSE new_task → DB | ✅ | [qa-hub-05](../../tests/qa-hub-05-roundtrip/) R3 全闭环 PASS（~11s） |
| HUB-06 | utok 被撤销后，它派生的 ntok 立即失效 | 🟡 | [qa-hub-06](../../tests/qa-hub-06-token-revoke/) R5 PASS — utok 撤销 + 显式 ntok revoke 工作；**reset-user 不级联 ntok**（auth.ts L267 只 DELETE network_id IS NULL 行）— 待 Vincent/通信龙 评设计 |
| HUB-06b | utok 跨用户隔离 / IDOR 边界 | ✅ | [qa-hub-06b](../../tests/qa-hub-06b-cross-user-isolation/) R17 PASS（~10s）— bob 偷不到 alice 的 network/task/status/messages，显式 IDOR + cross-tenant inject + mint 全拒 |
| HUB-07 | SSE 断线后重连不丢消息 | ✅ | [qa-hub-07](../../tests/qa-hub-07-sse-reconnect/) R9 PASS（~12s）— pin fire-and-forget + get_inbox backlog 契约 |
| HUB-08 | hub 重启不丢状态（sessions + tasks + ntok + SSE 重订） | ✅ | [qa-hub-08](../../tests/qa-hub-08-restart-persistence/) R11 PASS（~10s）— NODE-04 的 hub-side 半边 |
| HUB-09 | task 状态机 delivered→replied/failed/cancelled + terminal reply hard reject | ✅ | [qa-hub-09](../../tests/qa-hub-09-task-state-machine/) — 3 分支 + cancelled inbox auto-ack + send_reply terminal structured error + cancel_task terminal ok:false |
| HUB-18 | send/reply delivery semantics: missing alias vs offline queue vs bad reply | ✅ | [qa-hub-18](../../tests/qa-hub-18-delivery-semantics/) Wave 1 PASS — `alias_not_found` 不入库，`alias_offline` 入 inbox/tasks 但明确 queued，bad `send_reply` 返回结构化错误 |

## agent-node 矩阵（persona: runtime adapter）

| ID | 用户故事 | 现状 | 现有覆盖 |
|----|---------|------|---------|
| NODE-01 | claude-code-cli runtime 启动 + 注册 | ✅ | docker-e2e SC03 |
| NODE-02 | 收到 inbound task → 回复落 hub（成功路径） | ✅ | [qa-node-02](../../tests/qa-node-02-success-reply/) R6 PASS（~8.5s）— mock-via-MCP，不烧 LLM |
| NODE-03 | LLM key 错误时 reply.status=failed 写回 hub | ✅ | docker-e2e SC05 |
| NODE-03b | task_events 审计追踪（delivered/acked/replied/failed/cancelled）+ actor 归属 | ✅ | [qa-node-03b](../../tests/qa-node-03b-task-events/) R15 PASS（~15s）— 抠出 2 个 audit gap |
| NODE-04 | hub 重启后 agent-node SSE 自动重连 | 🟡 | hub-side 半边 ✅ [qa-hub-08](../../tests/qa-hub-08-restart-persistence/) R11；agent-side（real CLI 自动重连）留 NODE-04b |
| NODE-05 | runtime 切换（`claude-code-cli` → `codex-sdk` / `claude-agent-sdk`；R209 chain 校准；`minimax` 是 `http-api` alias 不算主流） | ❌ | （v1，先不做） |
| NODE-06 | config.json 缺 session 字段时自动补 UUID | ✅ | report-test31 L0 |

## dashboard 矩阵（persona: 浏览器端使用者）

| ID | 用户故事 | 现状 | 现有覆盖 |
|----|---------|------|---------|
| DASH-01 | 我能在 `/login` 注册并落到 dashboard | ✅ | docker-e2e SC01 |
| DASH-02 | 我能看到自己网络下在线的 agent-node | ✅ | docker-e2e SC03 |
| DASH-03 | 我打字 + Enter 就能发任务（不是 Cmd+Enter） | ✅ | docker-e2e SC04 |
| DASH-04 | agent 失败回复时聊天 + 状态 pill 同步 | ✅ | docker-e2e SC05 |
| DASH-05 | 我刷新页面历史还在 | ✅ | docker-e2e SC06 |
| DASH-06 | 我连发 3 条顺序不乱 | ✅ | docker-e2e SC07 |
| DASH-07 | 未登录访问 `/` 被拒 / 重定向 | ✅ | [qa-dash-07](../../tests/qa-dash-07-auth-boundary/) R16 PASS（~14s）— hub-side auth boundary 24 个探测（GET/POST/PUT/SSE/MCP/admin-only） |
| DASH-08 | 跨账号不能看到别人的节点（dashboard 多端点） | ✅ | [qa-dash-08](../../tests/qa-dash-08-cross-account-views/) R19 PASS（~11s）— /api/nodes / stats / completions / tasks-filters / tokens / task_events 7 端点跨账号全隔离 |
| DASH-09 | 关键页视觉无回归（TopoGraph / chat / node card） | 🟡 | dashboard repo Playwright（[N站马]每轮自审），跨仓库列为 L3v 保护资产 |
| DASH-10 | dashboard 增量轮询 since= 过滤（取代 SSE，utok 不能直接订阅） | ✅ | [qa-dash-10](../../tests/qa-dash-10-incremental-poll/) R20 PASS（~14s）— /api/messages + /api/completions since= 过滤工作 + 2 个 gap |

## 代码视角（L0 单测）补丁清单

跟 [strategy.md L0 目标](strategy.md#3-测试分层从低到高) 对应：

| ID | 目标文件 | 测什么 | 优先级 |
|----|----------|--------|--------|
| UT-01 | `server/src/db.ts` (token gen + hash) | utok/ntok/atok 形状 + uniqueness + hashToken/hashPassword 契约 | ✅ [qa-ut-01](../../tests/qa-ut-01-auth-tokens/) 19 断言 / 76 expect / ~250ms |
| UT-02 | `server/src/password-dict.ts` | 弱密码命中字典即拒 | ✅ [qa-ut-02](../../tests/qa-ut-02-password-dict/) 19 断言 PASS，local ~55ms / Docker ~0.5s |
| UT-03 | `server/src/auth.ts register()` | username 规则 + password 长度 + 字典 + admin 旁路 + CJK | ✅ [qa-ut-03](../../tests/qa-ut-03-auth-validate/) 23 断言 / 34 expect / ~290ms |
| UT-03 | `server/src/db.ts` | task 状态机非法迁移被拒（completed→pending 等） | ⭐ |
| UT-04 | `agent-network/bin/cli.ts` 解析层 | flag / 子命令解析（先重构成可测纯函数） | 大文件，分多轮 |
| UT-05 | `agent-network/src/client.ts` | 已有 [client.test.ts](../../agent-network/src/client.test.ts) 保持，按需补边界 | 维护 |

## 优先级（v0 R2 候选）

按 ROI 排序，下一轮选 **HUB-05**（最核心的「闭环」用户故事）：

1. **HUB-05**：register → mint → send → SSE — 是 commhub 的存在理由，必须有保护
2. **HUB-06**：utok 撤销 → ntok 失效 — 安全边界，错了就出事
3. **NODE-04**：hub 重启 SSE 重连 — 真实生产最高频痛点

R2 落地 **HUB-05** 一个；其余进 backlog。
