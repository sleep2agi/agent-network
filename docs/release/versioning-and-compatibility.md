# anet 多包版本兼容与依赖管理

> anet 由 4 个独立 npm 包组成（CLI / runtime / hub / dashboard），它们 **npm 层解耦、运行时耦合**。本文档管理它们之间的依赖契约、版本兼容矩阵、以及「谁跟谁一起升」的规则，并给出下一个 latest 的发布计划。发布前对照本文，改了契约的包必须一起升 + 记进矩阵。

## 1. 四个包 + 角色

| 包 | 角色 | 装在哪 |
|----|------|--------|
| `@sleep2agi/agent-network` | CLI / 编排（`anet` 命令：init/login/node create/channel/wizard），**spawn agent-node** | 操作机（每台跑 anet 的机器） |
| `@sleep2agi/agent-node` | 单节点 runtime（think() + 5 种 runtime + channel worker），连 hub | 每个节点所在机器 |
| `@sleep2agi/commhub-server` | Hub（会话注册 / SSE 推送 / task 路由 / REST API） | 中心 hub 机器（1 台） |
| `@sleep2agi/agent-network-dashboard` | Web 指挥台（Next 应用），走 commhub REST | 装在跑 dashboard 的机器（npm 包，本地起） |

dashboard 跟 commhub 的 REST 契约（C3）要版本约束——纳入本文档一起管，兼容矩阵（§4）给它一列。（旧的 Vercel 部署已废弃，现在统一走 npm 本地起。）

## 2. 🔑 关键事实：npm 解耦，运行时耦合

- 四个包的 `package.json` **互相没有 `@sleep2agi/*` 依赖**。装 agent-network 不会自动带来 agent-node。
- 耦合发生在**运行时**：
  - **agent-network → agent-node**：CLI `spawn('agent-node', …)`，靠约定（`.anet/nodes/<alias>/config.json` 形状、runtime 名、launch 参数）。CLI 只在文档/wizard 里叫你 `npm i -g @sleep2agi/agent-node`。
  - **agent-node → commhub-server**：走 hub 协议（注册 / SSE / task）+ `protocolVersion`。
  - **dashboard → commhub-server**：走 hub REST API。
- **后果**：没有 npm 强制的版本一致性。可以装出「新 CLI + 旧 runtime」或「新 runtime + 旧 hub」这种错配，然后在运行时炸。**这就是本文档存在的原因。**

## 3. 三条兼容契约（改了就要一起升 + bump 信号）

| # | 契约 | 谁 ↔ 谁 | 定义在 | 破坏性改动的信号 |
|---|------|---------|--------|------------------|
| C1 | 节点 spawn 契约：config.json 形状、runtime 名、launch 参数、`assertStartCompatibility` | agent-network ↔ agent-node | `agent-network/bin/cli.ts` + `agent-node/src/cli.ts` | 加 runtime / 改 config 字段 → 两包一起升 minor |
| C2 | Hub 协议：注册 / SSE 事件 key / task envelope / `protocolVersion` | agent-node ↔ commhub-server | `agent-node/src/*` + `server/src/index.ts` | 改协议 → bump `protocolVersion` + hub 加 backward-compat |
| C3 | Hub REST API | dashboard ↔ commhub-server | `server/src/index.ts` | 改/删 endpoint → dashboard 同步 + 保旧路由 |

## 4. 版本兼容矩阵（已知良好组合）

> 每次「一起测过」的组合记一行。装的时候四列尽量取同一行。四个都是 npm 包，dashboard 列也记 npm 版本。

> ⚠️ **前三行是 2026-06 preview 迭代期的历史快照**（数字 `preview.14/.18/.19/.20`，已远早于当前 preview 头）。当前已发布 preview 数字见 [`docs/plans/release-plan.md`](../plans/release-plan.md) 与 `npm view <pkg> dist-tags` 实测；下面单独加一行 **已发布 preview 头（snapshot 2026-08-14）** 作为最新真值参考。

| 组合 | agent-network | agent-node | commhub-server | dashboard | 状态 |
|------|--------------|-----------|----------------|-----------|------|
| 当前线上飞书舰队（2026-06 快照） | 2.3.0-preview.18 | 2.5.0-preview.18 | 0.9.0-preview.14 | 0.6.3-preview.4 | ✅ 当时实跑中（#383 rescue + Kimi）；生产真机版号请复核 |
| 已发布 preview 头（2026-06 快照） | 2.3.0-preview.19 | 2.5.0-preview.18 | 0.9.0-preview.20 | 0.6.3-preview.4 | ⚠️ 未整体 e2e，agent-node 不含 opencode |
| 下一发（2026-06 快照，含 opencode） | 2.3.0-preview.20 | 2.5.0-preview.19 | 0.9.0-preview.20 | 0.6.3-preview.4 | 🔜 待切（见 §6，dashboard 本发不动） |
| **已发布 preview 头（snapshot 2026-08-14）** | **2.3.0-preview.39** | **2.5.0-preview.31** | **0.9.0-preview.29** | 0.6.3-preview（浮动） | ⚠️ `npm view @preview` 实测；`preview.39` 二进制内嵌 `.d.ts` pair 仍指 `agent-node@2.5.0-preview.28`（main-源码 vs binary 差） |
| v2.3.0 GA 目标 | 2.3.0 | 2.5.0 | 0.9.0 | 0.7.0（含 #260） | 🎯 整行测绿才升 |
| latest（稳定线） | 2.2.21 | 2.4.13 | 0.8.8 | 0.6.x | ✅ 旧稳定，无 opencode/无 #383 |

## 5. Bump-together 规则

- 改 **C1**（runtime/config）→ agent-network + agent-node 同一次一起发 preview，矩阵加新行。
- 改 **C2**（hub 协议）→ 先升 hub（向后兼容旧 node）再升 node；`protocolVersion` 记进矩阵注。
- 改 **C3**（REST）→ commhub + dashboard 同步，保旧路由一个版本周期。
- 只改一个包内部（不碰契约）→ 单包发 preview 即可。
- **latest GA 必须整行一起测过再升**（不许单包偷升 latest）。

## 6. 下一个 latest 里程碑

**主题：节点全生命周期管理（增删改重启 + dashboard 配置）为主，IM channel 稳固；opencode 第 5 runtime 收尾放最后。**

里程碑 = agent-network 2.3.0 · agent-node 2.5.0 · commhub 0.9.0 · dashboard 0.7.0。

详细规划（已合 main / GA 前 TODO / 逐个 preview 路线图 / exit criteria / changelog）见 **[v2.3.0/plan.md](v2.3.0/plan.md)**，本文档不重复维护，只管跨版本兼容矩阵与契约。

> `lark-opencode-server` 是独立工具，**不属于本 anet 里程碑**（见 §8）。

## 7. Release SOP（复用现成）

- fresh clone main → 各包 `bun install` → `npm version <精确版> --no-git-tag-version` → `npm publish --tag preview`（prepublishOnly 自动 build）
- 验：dist 关键串在 + `grep -c 'Bun\.' dist` = 0
- **npm publish 顺序** = **server → agent-node → agent-network**（被依赖的先发；矩阵新行也按这条顺序试）
- 每 preview 带一句 changelog；latest 严格两阶段（preview 亲测 + 30min 窗口）

### 7.1 Operator upgrade 顺序（生产升级现网）

> 上面 §7 是「npm publish 顺序」（哪个包先 push 到 registry）。**生产环境升级现有 hub + 节点是另一回事** — 顺序反着来，先升 hub 后升 client。

**推荐流程**：

1. **先升 hub**（`commhub-server` on 中心机）—— 新 hub 兼容旧 agent-node 的 report_status shape（我们主动写 backward-compat），旧 hub 通常不认识新 agent-node 报的 snapshot 字段（zod strip 或直接不写）。
2. **再升 agent-node**（每台机器上的 runtime）—— 一台一台滚，`anet upgrade` + `anet project restart` 让新 runtime 上线。
3. **同时/最后升 CLI**（`agent-network`）—— 单机 CLI 不影响别的节点，节奏最松。
4. **dashboard 匹配 hub minor**（`agent-network-dashboard`）—— 跟 hub 走同一档；REST 契约（C3）跨 minor 需要 hub 保旧路由才能滞后升。

**为什么不能反着来（先升 node 后升 hub）**：新 agent-node 的 `buildConfigSnapshot` 会 emit 新字段（例如 #338 PR3 nest 后的 `daemon_capabilities`）；旧 hub zod schema 不认识 → 静默 strip → hub 存进 `nodes.config_snapshot` 的形状里就少字段，`list_host_supervisors` 靠 `role`/`daemon_capabilities.*` 过滤时可能空 → dashboard picker 空 → 建节点向导整条走不通。可复现的具体案例见 §9 GA-blocker #2 定性。

### 7.2 混装组合的快速自查

改动落到生产后想快速验证兼容性：

```bash
# 1. 看每台机器实际装的版本（别信 anet.sh 说的最新，看真号）
anet -v                                   # agent-network CLI
agent-node --version                      # agent-node runtime（在 daemon 机上）
curl -s $HUB/health | jq .version         # commhub-server

# 2. 起一个 fresh daemon 看 config_snapshot 是不是 populate 得上
anet daemon up smoke-daemon
sleep 3
curl -s "$HUB/api/nodes" -H "Authorization: Bearer $UTOK" \
  | jq '.nodes[] | select(.alias=="smoke-daemon") | {role, has_snapshot: (.config_snapshot != null)}'
# 期望: {"role":"host_supervisor","has_snapshot":true}
```

如果 `role` 是 `null` 或 `has_snapshot` 是 `false` — hub 侧没吸收到 daemon 报的 snapshot，八九不离十是 hub 太旧不认识 agent-node 报的新字段（或 SEC-1 拒了 upsert；hub log tail 会 print `[commhub] 🚫 report_status cross-network ...`）。

## 8. Backlog（GA 后）

- opencode plugin 解锁 Bearer-only vendor（opencode 内建硬编码 x-api-key，兼容网关开箱不通）
- `lark-opencode-server` 是独立工具（另一条线），不进本矩阵

## 9. 已定性的 mismatch 事件 — GA-blocker #2 (2026-07-04)

**症状** — 通信龙 在生产 hub `:9200`（commhub `0.9.0-preview.14`）上跑 `anet daemon up ga-daemon`（`agent-network 2.3.0-preview.21` / `agent-node 2.5.0-preview.19`），daemon 成功注册 + SSE 上线，但：

- `/api/nodes` 里该 daemon 的 `config_snapshot=None`（顶层抽出的 `role` 也是 `None`）
- `/api/host-supervisors`（`list_host_supervisors` filters on `config_snapshot.role`）返回 `count=0`
- Dashboard 建节点向导 step 1 picker 永空 → **走不下去**

**定性** — 两种版本组合各起一台 clean-state docker 复跑（tmpfs `/tmp` + `/root`，fresh `~/.anet`，没有既有 nodes 表数据）：

| 组合 | commhub | agent-node | anet CLI | 结果 | SQL `LENGTH(config_snapshot)` | `list_host_supervisors.count` |
|------|---------|-----------|----------|------|-------------------------------|-------------------------------|
| A: 对齐 | `0.9.0-preview.21` | `2.5.0-preview.19` | `2.3.0-preview.21` | ✅ 第一 shot | 281 chars | 1 |
| B: 通信龙 prod 组合 | `0.9.0-preview.14` | `2.5.0-preview.19` | `2.3.0-preview.21` | ✅ 第一 shot | 281 chars | 1 |

两组 `t=1s` 就把 `{model, flags, config_revision, config_update_capable, role:"host_supervisor", daemon_capabilities:{runtimes_supported,allowed_secret_keys,max_concurrent_children}}` 完整存进 `nodes.config_snapshot`。

**结论**：**不是 compat bug，也不是 agent-node → hub 首次 publish 断链**。B 组合（通信龙 prod 的确切版本）clean docker 里 handle 正确。生产 hub 的 `config_snapshot=None` 是 **prod-state issue** — 大概率某几种之一：

- **既有 dirty row**：daemon 之前用其他 alias/id 注册过，nodes 表里那行 `config_snapshot` 是 legacy state；新 `anet daemon up` 复用了 node_id 但 UPDATE 用了 `if (input.config_snapshot)` gate 触发不了（例如 W1 restart-path 里的 draining 窗口刚好被抓在中间）。
- **`config_snapshot` clobber**：hub prod 上跑了 181 个节点、大量 child ops；这条在 P3 (RFC-026) 时就 flag 过 —— 「child registration path may erase parent daemon's config_snapshot column」。通信龙 在 P3 时决定不在 P3 fix，backlog 记着；GA-blocker #2 让它从 backlog 升到 **可能影响 busy hub 的 picker**，值得单独复跑定性再决定 GA 前修不修。
- **SEC-1 cross-network refuse**：`upsertNodeWithSec1Guard` 若判 caller/existing net 不一致会直接返回 `refused` + 只 `console.warn`，dashboard 侧完全看不见。翻 hub log tail 是不是有 `[commhub] 🚫 report_status cross-network node upsert refused` 即可。

对 GA 意义：**picker 代码路径本身正确**，GA 阻断只在特定 prod 状态下会重现；短线的运维恢复 = 定位 & 清那行 dirty row（`DELETE FROM nodes WHERE alias=… AND config_snapshot IS NULL` 或 `anet daemon down` + 换新 alias）。长线是 §7.1 的升级顺序 + P3 clobber backlog 是否升级为 GA-blocker 的独立评估。

**Repro artifacts**（docker + shell）留在 branch `docs/ga-compat-matrix` 下 `docs/tests/p-ga2-compat-repro/`（Dockerfile.aligned / Dockerfile.mixed / repro.sh），未来再遇到类似疑似 compat 事件复用。
