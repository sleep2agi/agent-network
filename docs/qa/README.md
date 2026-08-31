# anet QA — 入口与导航

> 跟随 [issue #31](https://github.com/sleep2agi/agent-network/issues/31) 5min loop 增量构建。
> v0 目标：**让测试体系一步步融入研发流程，不阻塞 anet 迭代**。

## 一键跑

```bash
bash scripts/qa.sh           # L0 + L1 全跑
bash scripts/qa.sh --l0      # 只跑 L0 单测 (~0.1s)
bash scripts/qa.sh --l1      # 只跑 L1 contract 测试
bash scripts/qa.sh --list    # 列测试名 + 文件路径
```

> **关于耗时**:本页此前写「~16s warm」,`v0-summary.md` 写「本地一键 ~93s」,
> 而 `v0-summary.md` 自己那张逐条表加起来是 **156s**。三个数字都没说明自己量的是
> 什么条件,所以谁都不能拿来对照。已把死数字去掉 —— **要知道现在多久,就跑一次**:
>
> ```bash
> time bash scripts/qa.sh          # 你这台机、这个 Docker 缓存状态下的真实耗时
> ```
>
> 156s 是**逐条串行相加**;低于它的墙钟数意味着有并行。冷启动(需要拉镜像)会显著更久。

退出码：`0` 全过；`1` 至少一个 fail；`2` 环境问题（docker 不可用等）。

## CI 自动跑

[.github/workflows/qa.yml](../../.github/workflows/qa.yml) — PR / push to main 时自动跑（路径过滤）。

### CI 侧的实测成本（2026-08-18，`L1_TESTS` = 22 个套件）

上面那段说的是「你这台机」。**CI 是另一个对象,数字不能互相套用** —— 所以单独记一次,
并且把条件写全,否则下次它又会变成一个没人知道怎么来的死数字:

```
job            L0 + L1 (report-only)      GitHub Actions ubuntu-latest
最近 8 次 main  137 / 151 / 157 / 158 / 165 / 177 / 180 / 188 s     中位 162s
job 预算        timeout 300 s              最长的一次仍余 37%
L1 并发上限     4                          日志里那行 `· L1 并发上限 = 4（0 = 不限;用 QA_L1_MAX_PAR 覆盖）`
Docker 缓存     冷                          GHA runner 每次都是干净的
L1 成员数       22                          `bash scripts/qa.sh --list` 可自数
```

🔴 **给的是区间不是单点,这是有意的。** 8 次里最短 137s、最长 188s,**差 37%** ——
只报中间那一个数,下一个人拿它当基线时会以为自己的运行「异常慢」。

🔴 **别把这个数和本机的对照。** 三处不同:CI 每次冷启动(要重新 build 镜像)、
run 阶段有 4 路并行、而 `qa.sh` 的 **build 是串行的**。同一份脚本在两种环境下
的耗时结构完全不一样。

**怎么自己重新量(不要抄上面这个数):**

```bash
# 取最近一次 main 上的该 job 时长
gh run list --workflow=qa.yml --branch=main --limit 5 --json databaseId --jq '.[].databaseId' |
while read id; do
  gh api "repos/sleep2agi/agent-network/actions/runs/$id/jobs" \
    --jq '.jobs[] | select(.name|test("L0 . L1")) | "\(.name) \(.started_at) \(.completed_at)"'
done
```

⚠️ **要 step 的时长就取 `.steps[]`,不要拿 job 时长去比 step 上的 `timeout-minutes`** ——
job 里还含 checkout / Setup Bun / 依赖安装,那些不受那个上限管(#924 上踩过两次)。

**Report-only**：失败时 PR 显示红 ✕，但**不阻塞合并**（branch protection 未加这个 check）。
目的是让大家看见结果，不当拦路虎。详见 [strategy.md §4](strategy.md#4-ci-gate渐进三档)。

## `L0 + L1 (report-only)` 红了怎么读

**四种完全不同的失败，在 `gh pr checks` 那一行上逐字相同**：

```
L0 + L1 (report-only)   fail   <时长>
```

2026-08-31 一天内四种全撞到了。分辨只靠日志里的**三个信号**：

| # | 日志签名 | 真相 | 该做什么 |
|---|---|---|---|
| ① | `✓ ALL PASS in <N>s` + `L1-TIMING v1 total=<N>s suites=70` | **跑完了**，只是慢（当日 1777s ≈ 2 倍） | 不动闸。`timeout-minutes` 是 runaway 守卫，不是性能预算（见 `qa.yml` 该 job 的注释） |
| ② | **没有 `L1-TIMING`**；最后一条输出之后长时间静默 | **某个套件挂住**，被 30 分钟守卫掐 | 找「build 了但没 done」的那个（下面有命令） |
| ③ | `L1-TIMING` 有，但 **`suites=` 比平时少** + `failed to solve` / `failed to build` | **构建阶段就没起来**，那个套件根本没跑 | 常见成因：Dockerfile 里未 pin 的 `curl https://bun.sh/install`（存量豁免见 `docs/bun-install-pin-baseline.txt`，跟踪在 #728） |
| ④ | `L1-TIMING` 有、`suites=` 正常，某条测试打出断言失败 | **真的测试红** | 按测试立案（#1593 在统计这一类的红率） |

### 取这三个信号

```bash
# run 未跑完时这个接口常取不到（会返回一小段错误 XML）——等 job completed 再取
gh api "repos/sleep2agi/agent-network/actions/jobs/<job-id>/logs" > /tmp/l.log

grep -oE 'L1-TIMING v1 [^ ]* [^ ]*' /tmp/l.log     # 有 = 跑完；无 = 挂住
grep -cE 'failed to solve|failed to build' /tmp/l.log   # >0 = 构建阶段没起来
# suites= 与当前值比：`bash scripts/qa.sh --list | grep -c '^  - tests/'`
```

**挂住时，找是哪个套件**（两侧都取自**同一份日志**，不引外部名单）：

```bash
grep -oE '· build [a-z0-9-]+' /tmp/l.log | sed 's/· build //' | sort -u > /tmp/b
grep -oE '(· L1 done|✓ L1) [a-z0-9-]+' /tmp/l.log | sed -E 's/^(· L1 done|✓ L1) //' | sort -u > /tmp/d
comm -23 /tmp/b /tmp/d      # build 了但没 done 的 —— 就是它
```

🔴 **几条踩过的坑**：

- **算 job 年龄用 `jobs[].started_at`，不要用 `runs[].created_at`** —— 后者含排队时间，
  会把「刚跑 11 分钟」读成「已经 33 分钟」，从而误判成撞了守卫。
- **`gh pr checks` 的耗时列在 `pending` 时是 `0`**，不能拿来算年龄。
- **判「跑没跑完」用 `status != "completed"`，不要用 `conclusion == null`** ——
  `gh` 对进行中的 run 返回的是**空串 `""`**。
- **比对套件名要比全名**：`test225-node-stop-convergence` 与
  `test225-grok-preview-package-live` 是两个不同套件，只比 `test225` 会把结论带偏。


## 文档导航

- **[strategy.md](strategy.md)** — 哲学 / 分层 / 资源 / 节奏
- **[test-matrix.md](test-matrix.md)** — 4 persona 矩阵 + L0 单测清单 + 状态
- **[v0-summary.md](v0-summary.md)** — v0 ship-readiness 盘点（R1-R20 累计成果）
- **[v1-roadmap.md](v1-roadmap.md)** — v1 路线提案（5 方向，等 Vincent 拍板）
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
| CLI-01 | [tests/qa-cli-01-hub-start](../../tests/qa-cli-01-hub-start/) | anet hub start banner + /health + admin-utok 600 + 幂等 |
| CLI-02 | [tests/qa-cli-02-network-create](../../tests/qa-cli-02-network-create/) | anet login + network create + ls + dup + whoami |
| DASH-07 | [tests/qa-dash-07-auth-boundary](../../tests/qa-dash-07-auth-boundary/) | hub-side auth boundary（24 个探测：GET/POST/SSE/MCP/admin） |
| DASH-08 | [tests/qa-dash-08-cross-account-views](../../tests/qa-dash-08-cross-account-views/) | 跨账号 dashboard 多端点 IDOR（nodes/stats/completions/filters/tokens/events） |
| DASH-10 | [tests/qa-dash-10-incremental-poll](../../tests/qa-dash-10-incremental-poll/) | dashboard 增量轮询 since= 过滤（messages + completions） |
| HUB-05 | [tests/qa-hub-05-roundtrip](../../tests/qa-hub-05-roundtrip/) | commhub register→mint→send→SSE→DB |
| HUB-06 | [tests/qa-hub-06-token-revoke](../../tests/qa-hub-06-token-revoke/) | commhub utok/ntok 撤销契约 |
| HUB-06b | [tests/qa-hub-06b-cross-user-isolation](../../tests/qa-hub-06b-cross-user-isolation/) | commhub 跨用户 IDOR 边界 |
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
