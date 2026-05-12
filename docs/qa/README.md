# anet QA — 入口与导航

> 跟随 [issue #31](https://github.com/sleep2agi/agent-network/issues/31) 5min loop 增量构建。
> v0 目标：**让测试体系一步步融入研发流程，不阻塞 anet 迭代**。

## 一键跑

```bash
bash scripts/qa.sh           # L0 + L1 全跑 (~16s warm)
bash scripts/qa.sh --l0      # 只跑 L0 单测 (~0.1s)
bash scripts/qa.sh --l1      # 只跑 L1 contract 测试 (~16s)
bash scripts/qa.sh --list    # 列测试名 + 文件路径
```

退出码：`0` 全过；`1` 至少一个 fail；`2` 环境问题（docker 不可用等）。

## CI 自动跑

[.github/workflows/qa.yml](../../.github/workflows/qa.yml) — PR / push to main 时自动跑（路径过滤）。

**Report-only**：失败时 PR 显示红 ✕，但**不阻塞合并**（branch protection 未加这个 check）。
目的是让大家看见结果，不当拦路虎。详见 [strategy.md §4](strategy.md#4-ci-gate渐进三档)。

## 文档导航

- **[strategy.md](strategy.md)** — 哲学 / 分层 / 资源 / 节奏
- **[test-matrix.md](test-matrix.md)** — 4 persona 矩阵 + L0 单测清单 + 状态
- 历史报告：[../tests/report-*.txt](../tests/)

## 当前测试库

### L0 — bun test（代码视角，ms 级）

| ID | 文件 | 跑 |
|----|------|----|
| UT-01 | [server/src/auth-tokens.test.ts](../../server/src/auth-tokens.test.ts) | `COMMHUB_DB=/tmp/x.db cd server && bun test src/auth-tokens.test.ts` |
| UT-02 | [server/src/password-dict.test.ts](../../server/src/password-dict.test.ts) | `cd server && bun test src/password-dict.test.ts` |
| UT-03 | [server/src/auth-validate.test.ts](../../server/src/auth-validate.test.ts) | `COMMHUB_DB=/tmp/x.db cd server && bun test src/auth-validate.test.ts` |

### L1 — Docker contract（用户视角，10-15s/条）

| ID | 测试 | persona |
|----|------|---------|
| CLI-02 | [tests/qa-cli-02-network-create](../../tests/qa-cli-02-network-create/) | anet login + network create + ls + dup + whoami |
| DASH-07 | [tests/qa-dash-07-auth-boundary](../../tests/qa-dash-07-auth-boundary/) | hub-side auth boundary（24 个探测：GET/POST/SSE/MCP/admin） |
| HUB-05 | [tests/qa-hub-05-roundtrip](../../tests/qa-hub-05-roundtrip/) | commhub register→mint→send→SSE→DB |
| HUB-06 | [tests/qa-hub-06-token-revoke](../../tests/qa-hub-06-token-revoke/) | commhub utok/ntok 撤销契约 |
| HUB-07 | [tests/qa-hub-07-sse-reconnect](../../tests/qa-hub-07-sse-reconnect/) | commhub SSE 断重连 + get_inbox 拉 backlog |
| HUB-08 | [tests/qa-hub-08-restart-persistence](../../tests/qa-hub-08-restart-persistence/) | commhub 重启不丢状态 + SSE 重订 |
| HUB-09 | [tests/qa-hub-09-task-state-machine](../../tests/qa-hub-09-task-state-machine/) | task 状态机 3 分支 + terminal no-op |
| NODE-02 | [tests/qa-node-02-success-reply](../../tests/qa-node-02-success-reply/) | agent-node 成功回复（mock-via-MCP） |
| NODE-03b | [tests/qa-node-03b-task-events](../../tests/qa-node-03b-task-events/) | task_events 审计追踪 + 3 个 scenario |

### L2 / L3 — 历史保护资产，不动

| 测试 | 层 | 说明 |
|------|-----|------|
| [tests/test30-v0.8-auth-deprecation](../../tests/test30-v0.8-auth-deprecation/) | L2 | v0.8 auth 系列 CLI smoke |
| [tests/test31-claude-code-cli-resume](../../tests/test31-claude-code-cli-resume/) | L0+L2 | claude-code-cli session resume |
| [agent-network/tests/docker-e2e](../../agent-network/tests/docker-e2e/) | L3 | 7 场景 dashboard + agent-node E2E |

## 加新测试的最小步骤

1. 在 [test-matrix.md](test-matrix.md) 找对应格子，把现状 ❌ → 🟡
2. 写测试：
   - L0：`<module>/src/<file>.test.ts` 旁边
   - L1+：`tests/qa-<id>-<topic>/{Dockerfile,run.sh,README.md}`
3. 实跑通过：本地 `bun test` 或 `sg docker -c 'docker build ... && docker run ...'`
4. 把新测试加进 [scripts/qa.sh](../../scripts/qa.sh) 的 `L0_TESTS` / `L1_TESTS` 数组
5. 写 [docs/tests/report-<id>.txt](../tests/)：步骤 + 结果 + 抠出的契约
6. 矩阵 🟡 → ✅，commit + push
