# anet QA v0 — Ship-readiness 盘点

> issue [#31](https://github.com/sleep2agi/agent-network/issues/31) R1–R20 累计成果（2026-05-12，第一天）。
> 配套 [v1-roadmap.md](v1-roadmap.md) — 等 Vincent / 通信龙 拍板方向。

## 一句话

**16 条 R 系列 QA 测试 + CI workflow 上线 + 11 条 SDK 设计 finding 抠出。**
3 persona 用户视角包圆（CLI / commhub / dashboard），1 persona 用户视角 4/6（agent-node），代码视角 3/5。
本地一键跑 ~93s（**2026-05 首次测量的墙钟值**；下面逐条表串行相加是 156s，差额来自并行。你这台机上的真值跑 `time bash scripts/qa.sh`），CI ~40s。不改任何业务代码。

## 测试库（16 条 R 系列 + 历史保护资产）

### L0 unit（代码视角，ms 级）

| ID | 文件 | 断言数 | 时间 |
|----|------|--------|------|
| UT-01 | [server/src/auth-tokens.test.ts](../../server/src/auth-tokens.test.ts) | 19 / 76 expect | 250ms |
| UT-02 | [server/src/password-dict.test.ts](../../server/src/password-dict.test.ts) | 19 / 25 expect | 55ms |
| UT-03 | [server/src/auth-validate.test.ts](../../server/src/auth-validate.test.ts) | 23 / 34 expect | 290ms |

### L1 contract（用户视角，Docker，s 级）

| ID | persona | 内容 | 时间 |
|----|---------|------|------|
| HUB-05 | commhub | register→mint→send→SSE→DB 闭环 | 11s |
| HUB-06 | commhub | utok/ntok 撤销 + cascade gap | 15s |
| HUB-06b | commhub | 跨用户 IDOR（OWASP A01）| 10s |
| HUB-07 | commhub | SSE 断连 + get_inbox backlog | 12s |
| HUB-08 | commhub | hub 重启不丢状态 | 10s |
| HUB-09 | commhub | task 状态机 3 分支 + terminal no-op | 12s |
| NODE-02 | agent-node | 成功回复 mock-via-MCP | 8s |
| NODE-03b | agent-node | task_events 审计追踪 | 15s |
| DASH-07 | dashboard | hub-side auth boundary（24 探测）| 14s |
| DASH-08 | dashboard | 跨账号多端点 IDOR（7 端点）| 11s |
| DASH-10 | dashboard | 增量轮询 since= 过滤 | 14s |

### L2 CLI smoke（用户视角，真 anet binary）

| ID | persona | 内容 | 时间 |
|----|---------|------|------|
| CLI-01 | CLI | anet hub start banner + 凭证 + 幂等 | 10s |
| CLI-02 | CLI | login + network create + ls + dup + whoami | 14s |

### 历史保护资产（不动）

| 来源 | 层 | 覆盖 |
|------|-----|------|
| [tests/test30-v0.8-auth-deprecation](../../tests/test30-v0.8-auth-deprecation/) | L2 | CLI v0.8 auth deprecation |
| [tests/test31-claude-code-cli-resume](../../tests/test31-claude-code-cli-resume/) | L0+L2 | claude-code-cli session resume |
| [agent-network/tests/docker-e2e](../../agent-network/tests/docker-e2e/) (7 SC) | L3 | dashboard 视觉 + agent-node failed reply |

## 4 persona × 双视角覆盖

| persona | 用户视角 | 代码视角 |
|---------|----------|----------|
| **CLI** | **7/7 ✅ ⭐** | ❌ cli.ts 4771 行 0 单测 |
| **commhub** | **9/9 ✅ ⭐** | 3/5 ✅（auth crypto / password dict / register validate） |
| agent-node | 4/6 | — |
| **dashboard** | **9/10 ✅ ⭐**（DASH-09 视觉回归 by design 在 dashboard repo） | — |

**3 persona 用户视角包圆**。剩两块洼地：
- agent-node 4/6 —— NODE-04b real CLI 自重连 / NODE-05 runtime 切换
- 代码视角 3/5 —— UT-04 cli.ts 解析层 / UT-05 client.test 维护

## 一键跑 + CI

```bash
bash scripts/qa.sh           # 全跑
bash scripts/qa.sh --l0      # 只 L0（单测，毫秒级）
bash scripts/qa.sh --l1      # 只 L1（每个套件一次 docker build + run）
bash scripts/qa.sh --list    # 列测试名
```

> 🔴 **这几行原来带着 `~93s` / `~80s`,已经去掉 —— 不是排版,是它们会骗人。**
>
> 上面「一句话」那段的 `~93s` 明确标了是 **2026-05 首次测量的墙钟值**,那是**记录**,
> 保留没问题。但这个速查块是**照抄用的**,它旁边的秒数读起来像「现在就是这么久」。
> **同一句过期的话,写在说明里和写在用户会复制的那一行里,代价不一样** ——
> 前者读者会连着上下文一起读到日期,后者他只会看见那个数。
>
> L1 的耗时随 `scripts/qa.sh` 里 `L1_TESTS` 的成员数走,而那个数一直在涨:
> 写下最早那个「~16s」时是 **3** 个(见 #871),`ce0c99ab` 上是 **22** 个。
> 每个成员各要一次 `docker build` + `docker run`。
>
> 要知道**你这台机、这个 Docker 缓存状态下**是多久:
>
> ```bash
> time bash scripts/qa.sh
> # L1 当前成员数（自己数，不要信这里写死的数字）：
> bash -c 'source <(sed -n "/^L1_TESTS=(/,/^)/p" scripts/qa.sh); echo "${#L1_TESTS[@]}"'
> ```

[.github/workflows/qa.yml](../../.github/workflows/qa.yml) **report-only**，PR + push to main 触发，不阻塞合并。
CI 真实抓 race ≥4 次（每次都是新 hub-bootstrap 后 auth race，固化 retry pattern）。

## 累计抠出的 11 条 SDK 设计 finding

| # | 来源 | gap | 建议 |
|---|------|-----|------|
| 1 | R5 (HUB-06) | utok reset-user **不级联** ntok（`auth.ts L267` 只 DELETE network_id IS NULL）| 设计还是 bug 待 Vincent 评 |
| 2 | R6 (NODE-02) | `/api/networks` POST 响应 shape 因 caller 异（admin top-level vs 普通 nested）| 统一 shape |
| 3 | R6 (NODE-02) | admin login 在 /health 200 后短暂 401（bootstrap race）| doc + retry 写进 SDK examples |
| 4 | R14 (HUB-09) | send_reply terminal silent no-op vs cancel_task terminal ok:false（不一致）| Wave 1 改为 send_reply terminal structured error；cancel_task 保持 ok:false |
| 5 | R5 (HUB-06) | POST `/api/auth/node-token` 响应缺 `token_id`，SDK 撤销自己 mint 的 ntok 要绕路 | 加 token_id 字段 |
| 6 | R5 (HUB-06) | `register()` 自动建 default network + ntok，新用户有 3 token 不是 2 | doc 明确 |
| 7 | R14 (HUB-09) | `cancel_task` 需 NTOK，admin UTOK 无干净取消路径 | hub 加 UTOK + network_id 路径 |
| 8 | R15 (NODE-03b) | `/api/task` REST 不写 task_events → Dashboard 派单 audit 入口断 | `/api/task` 调 `logTaskEvent` |
| 9 | R15 (NODE-03b) | `task_events` DESC 排序在亚秒事件下被 rowid tie-break 覆盖 | SQL 加 `, id DESC` |
| 10 | R20 (DASH-10) | `/api/messages` (SQLite datetime fmt) vs `/api/completions` (ISO fmt) `since=` 格式不同 | 统一 |
| 11 | R20 (DASH-10) | `completions` 表**只**由 `report_completion` 写，`send_reply` 不写 → dashboard /api/completions 看不到 send_reply 的回复 | hub mirror 或 doc 明确 |

**11 条都是测试逼出来的**（看代码也容易漏），全有 commit + 测试用例 + 源码 line 引用，**任何工程师 5min 内能复现 + 上下文**。

## 为什么是 ship-readiness 拐点

1. 4 persona × 双视角矩阵从 0 到 31 个 ✅（含历史保护资产）
2. 一键跑 + CI 已经在用，过去 20 轮**每次都验证有效**
3. 每个新测试都抠出 ≥1 个非显然契约 —— **ROI 仍在但开始递减**
4. 11 条 SDK finding 形成可处理 backlog，**不归 QA 工作流改业务代码**
5. v0 测试库稳定 7 周不会 break（不依赖业务代码改动，纯 contract pin）

下一阶段（v1）应该有**新的决策点**，不是简单延续矩阵补格子。参见 [v1-roadmap.md](v1-roadmap.md)。
