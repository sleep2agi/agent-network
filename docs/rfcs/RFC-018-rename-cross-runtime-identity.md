# RFC-018 — claude-code-cli rename 跨 runtime 身份一致性修复（#146）

- **状态**：Approved（通信龙 review 通过）—— 四 fix 已实现，待 测试马 gate + 双 review + Vincent UAT
- **作者**：通信工程马（牵头整合）
- **协作**：通信SDK马（B1 / node-server.ts lane）、通信牛（commhub-server lane）、通信测试马（验证）
- **关联**：#146（P0）、RFC-010 节点生命周期（rename 2PC，已 closed）、RFC-013 rename 零间隙热重载（v0.12.0 path）
- **目标 issue**：#146

---

## 1. 背景与问题

`anet node rename` 的 #146 修复（`c816dfa` → `d0ee7cd` R1-R6 → `ebb7982` R3）采用 Option B「重启」方案，
设计与 9-case Docker gate **只覆盖 agent-node SDK runtime**（`codex-sdk` / `claude-agent-sdk`）。

Vincent 真机 UAT：`anet node rename 指挥室 总指挥 --force`（`指挥室` 是 `claude-code-cli` runtime 指挥节点）。
CLI 输出 success，实际：
- 新节点 `总指挥` 注册到 commhub 时 `node_id=null`、`resume_id` 是裸 UUID（`3274eddd…`）；
- 旧节点 `指挥室` 行残留、`status=error` 没清掉；
- `tmux attach` 进新节点要手动按回车进程才动。

---

## 2. Root cause（三侧联合定位）

### 2.1 两个不同的 registrar（关键前提）

| | registrar A | registrar B |
|---|---|---|
| 实体 | `@sleep2agi/agent-node`（独立 npm 包） | `agent-network/src/node-server.ts`（随 agent-network 发布，落地为 `.anet/node-server.js`） |
| 用于 runtime | `codex-sdk` / `claude-agent-sdk` | **`claude-code-cli`** |
| `resume_id` | `sdk-<node_id>`（`agent-node/src/cli.ts:437`）—— **稳定** | `COMMHUB_RESUME_ID \|\| CLAUDE_RESUME_ID \|\| randomUUID()`（`node-server.ts:75`）—— **不稳定** |
| 注册发 `node_id` | 是 | 否 |

`指挥室/总指挥` 走 registrar B；对照节点 `副指挥`（`node_id=n_50c034f7`+`sdk-`）走 registrar A —— 不同 runtime，不可直接对照。

### 2.2 B1 —— claude-code-cli 的 commhub 身份对任何 restart 都不稳定

`node-server.ts:75`：`const RESUME_ID = process.env.COMMHUB_RESUME_ID || process.env.CLAUDE_RESUME_ID || randomUUID()`。
全仓库**没有任何地方 set 这两个 env**（`launchAgent` claude 分支 env 只有 `COMMHUB_ALIAS/TOKEN`，`ensureMcpJson` 写的 `.anet/.env` 只有 `COMMHUB_URL/TOKEN`）
→ 每次进程启动都 fall through 到 `randomUUID()` → **每次重启换一个全新随机 UUID**。

注册 payload（`report_status`，`node-server.ts:437-446`）只发 `resume_id`+`alias`+status/server/agent/project_dir，**不带 `node_id` 字段** → commhub 行 `node_id` 恒为 null。

> **澄清「node_id=null 是不是 rename 丢的」**：不是。证据 —— Vincent 看到的残留 `指挥室` 行 `last_seen` 在 rename 之前、`node_id` 也是 null，那行就是 rename 前的注册态本身。claude-code-cli 注册本来就 `node_id=null`。config.json **文件**里有 `node_id`（`createProfileFromOpts` 对所有 runtime 无条件 `generateNodeId()`），但它从没进过 registrar B 的注册路径。

→ rename 前 `资resume_id=a55acb51`、rename 后 `3274eddd`，不是 rename「改」了它，是 C4 重启重新 mint 了随机 UUID。`resume_id` 是 commhub session 行主键 → 主键变 = 新行 = 旧行 orphan。

### 2.3 B2 —— 旧行残留 `status=error`

`node-server.ts:472-481` `gracefulShutdown()`：L473 log 字面写 `"shutting down, reporting offline…"`，
但 L477 实际发 `status: "error"`。该函数只由 `stdin end` / `SIGTERM` / `SIGINT`（L483-485）触发 —— 全是干净/受控关闭信号，crash 到不了这里。
**log 说 offline、code 发 error，自相矛盾 —— error 是写错。** 这正是 UAT「旧行残留 error」的直接来源：每次受控重启旧进程都报 error。
叠加 2.2 的不稳定 resume_id → 旧行还成了永久 orphan（新进程 resume_id 不同，无法 upsert 回同一行）。

### 2.4 server 侧 —— commit 后的滞后 old-alias 调用重造 orphan

`commitRename`（`server/src/rename.ts:81`）= `UPDATE sessions SET alias=new_alias WHERE network_id+old_alias` —— 直接改 live `sessions` 行（按 alias）。
commit **之后** 旧进程/旧 channel 仍可能用 old alias 再 `report_status`、`send_task` 也可能 touch old alias，server 无 canonicalization → 重新造出 / 保活 old-alias orphan 行。

### 2.5 issue ③ —— `tmux attach` 要按回车

C4 重启的 claude 进程卡在某 prompt。claude-code-cli 在容器内无法真起（需真 `claude auth login` 订阅，卡 onboarding 向导 —— 测试马 3-probe 实证），Docker gate 无法覆盖 → 归 Vincent 真机 UAT。本 RFC 不含 ③ 实现，列 follow-up。

---

## 3. 影响面

- **这不止是「rename bug」**：claude-code-cli 节点的 commhub 身份（resume_id）对**任何**重启都不稳定 —— `anet node stop && start`、crash 自动重启、rename，今天都会 orphan 旧行。rename 只是把它暴露出来。
- 范围：所有 `claude-code-cli` runtime 节点。`agent-node` SDK 节点不受影响（`sdk-<node_id>` 已稳定）。
- **建议 review 决策**：是否单开一个独立 issue 跟踪「claude-code-cli restart 身份稳定性」（范围比 #146 大）；本 RFC 的 Fix 1 顺带根治它。

---

## 4. 整合方案 —— 三 fix 拼成一致的 rename 体验

### Fix 1 — B1：CLI 注入稳定 resume_id 【owner：通信工程马 / agent-network `bin/cli.ts`】

`launchAgent` 的 claude-code-cli 分支 env block（`cli.ts:~2203`）加：

```ts
COMMHUB_RESUME_ID: `cc-${profile.node_id}`,
```

- `node-server.ts:75` 的 env 钩子已存在 → **registrar B 零改动**，env 自然经 claude → MCP stdio 子进程继承（与现有 `COMMHUB_ALIAS` 同路径）。
- 结果：claude-code-cli 跟 agent-node 同套 `<prefix>-<node_id>` 稳定语义。restart（含 rename）→ 同 `resume_id` → commhub `ON CONFLICT(resume_id)` upsert 同一行 → 身份连续 + **不再产生 orphan**（B1 一处同时根治 B2 的 orphan 症状）。
- **edge — node_id 持久化**：`cc-<node_id>` 跨 rename 稳定的前提是 `node_id` 本身 rename 不变。#146 R3（`ebb7982`）已保证 renameCommand 把 canonical node_id 持久化进 config。Fix 1 额外要求：`launchAgent` 启动时若 `profile.node_id` 在 raw config 缺失（legacy），backfill + `saveProfile` 持久化（mirror R3），避免 `legacyNodeId()` 因目录名变化而漂移。
- **开放问题（review 拍）**：prefix 用 `cc-`（语义准确）还是复用 `sdk-`（commhub 完全统一处理）？取决于 commhub 是否对 `resume_id` 前缀有语义依赖 —— 见 §7。

### Fix 2 — B2：`gracefulShutdown` error→offline 【owner：通信SDK马 / agent-network `src/node-server.ts`】

`node-server.ts:477` `status: "error"` → `status: "offline"`。一词改。
SDK马 定性：**这是 bug 不是可选项** —— gracefulShutdown 只由干净/受控信号触发，L473 log 本就写 offline，与 agent-node shutdown 的 `report_status("offline")` 一致，低风险。

### Fix 3 — server canonicalization 【owner：通信牛 / commhub-server，已 approve、实施中】

- 新 helper `resolveCanonicalAlias` + `report_status` / `send_task` / `/api/status` 三处加 old→new 解析 + cleanup；`commitRename` 补 cleanup `DELETE`。
- 发 `commhub-server@0.8.3-preview.2`。
- 作用：纵深防御 —— Fix 1 让稳定 resume_id 不再产生 orphan，Fix 3 兜底「commit 后滞后的 old-alias 调用」不重造 orphan。

### Fix 4 — CLI 成功文案 + B2 CLI 半 【owner：通信工程马 / agent-network `bin/cli.ts`】

- `renameCommand` 成功文案按 runtime 分支：对 claude-code-cli 不再打印 `node_id: … unchanged`（该 runtime 的 commhub 身份不用 node_id，原文案误导）。
- B2 CLI 半：`terminateNodeProcess`（`d0ee7cd` R1）SIGTERM 旧 claude → 旧 `node-server.js` 经 stdin EOF 触发 `gracefulShutdown`（Fix 2 后报 offline）；现有 1500ms grace 保留。
  时序竞态分析：旧进程 `report_status(offline)` 与新进程 `report_status(idle)` 异步竞争 —— **有 Fix 1 后两者 upsert 同一行**，竞态只影响中间态，最终态由最后一个 report 决定（= 新进程 idle 心跳），可接受，不需额外阻塞等待。

### issue ③ — descope 到 Vincent UAT

候选 fix：`startNodeTmuxSession` 后 `tmux send-keys <session> Enter`，或排查 claude CLI 启动 flag。需 Vincent UAT 复现确认卡点状态后再定，列 follow-up。

---

## 5. 测试策略

| 项 | 方式 |
|---|---|
| B1 / B2 复现 + fix 验证 | claude-code-cli Docker 内无法真起 → mock = **直接起真 `.anet/node-server.js`**（真注册代码，不需 claude），against 容器内本地 commhub。step1 baseline（无 `COMMHUB_RESUME_ID` → randomUUID → 重启 orphan）；step2 fix（`COMMHUB_RESUME_ID=cc-<node_id>` → upsert 同行）；step3 gracefulShutdown（SIGTERM → 验报 offline） |
| agent-node SDK 回归 | 9-case gate 保持绿 —— Fix 1/4 只动 `launchAgent` claude 分支，不碰 SDK 分支，测试马重跑确认 |
| server canonicalization | 通信牛 commhub-server 侧自带测试 |
| issue ③ tmux-Enter | Docker 不可复现 → Vincent 真机 UAT |
| 全链路 cc-cli rename | 需真 claude 订阅 → Vincent 真机 UAT |

🔴 红线：全程 Docker 容器、本地 commhub（非 prod）、不在本机起测试节点。证据存 `docs/tests/p147-cc-rename-repro/`。

---

## 6. 发布计划

- **agent-network**（Fix 1 + Fix 2 + Fix 4，同 repo）→ preview bump `2.2.7-preview.1` → `2.2.7-preview.2`。
- **commhub-server**（Fix 3）→ `0.8.3-preview.2`。
- **PINNED_SERVER_VERSION**：`bin/cli.ts:61` 现 pin `0.8.3-preview.1`。Fix 3 的 canonicalization 是 rename 正确性的必需依赖 → 按 per-pin reasoning **必须 bump 到 `0.8.3-preview.2`**（否则 `anet hub start` 仍跑旧 server，rename 仍会 orphan）。review 确认。
- 顺序：三 fix 都 ready → 测试马 Docker gate（含 SDK 9-case 回归）→ 通信龙+通信牛 双 review → Vincent 真机 UAT（含 ③）→ Method B promote latest（clean `2.2.7`）。
- promote latest 持续 HOLD 至上述全过。

---

## 7. 风险 / 开放问题

1. **prefix `cc-` vs `sdk-`**：commhub 是否对 `resume_id` 前缀有语义依赖（如某处 `startsWith("sdk-")`）？需通信牛确认。无依赖 → `cc-` 更准确。
2. **一次性迁移**：现存 claude-code-cli 节点首次带 `COMMHUB_RESUME_ID` 重启后，旧随机 UUID 行成永久 orphan，靠 commhub offline timeout 自然清。可接受、一次性。
3. **PINNED_SERVER_VERSION bump**：见 §6，需 review 拍板。
4. **issue ③ 真实 root cause 未确认**：待 Vincent UAT 复现。
5. **是否单开 issue 跟踪 cc-cli restart 身份稳定性**（§3）：review 决策。

---

## 8. 实现进度

通信龙 设计 review：**APPROVE**。§7 开放问题决策：
- Q1 prefix：用 `cc-<node_id>`（通信牛 grep 确认 commhub 无 `resume_id` 前缀语义依赖；未确认前不 block）。
- Q2 PINNED_SERVER_VERSION bump：APPROVED —— preview 阶段 `2.2.7-preview.2` pin `0.8.3-preview.2`；promote latest 时按 Method B re-pin 到 clean server 版本。
- Q3 单开 issue：**不单开** —— §3 影响面已记录，Fix 1 顺带根治；在 #146 closeout + CHANGELOG 写明「同时修了 cc-cli 任何 restart 的身份漂移」。

| Fix | owner | 状态 | commit |
|---|---|---|---|
| Fix 1（CLI 稳定 resume_id + node_id backfill） | 通信工程马 | ✅ done | `0e301bf`（agent-network） |
| Fix 2（node-server.ts gracefulShutdown error→offline） | 通信SDK马 | ✅ done | `5681081`（agent-network） |
| Fix 3（commhub-server canonicalization） | 通信牛 | ✅ done | `81248bb`（commhub-server） |
| Fix 4（renameCommand 成功文案 runtime 分支） | 通信工程马 | ✅ done | `0e301bf`（agent-network） |
| issue ③（tmux-Enter） | — | follow-up，descope 到 Vincent UAT | — |

四 fix 全部实现完成。下一步：测试马 3-runtime Docker gate（含 SDK 9-case 回归）→ 通信龙+通信牛 双 review 代码 → Vincent 真机 UAT（含 ③）→ Method B 协同发布（agent-network `2.2.7-preview.2` / commhub-server `0.8.3-preview.2`，PINNED bump）。
