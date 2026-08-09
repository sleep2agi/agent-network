# RFC-028 — Provider & Model Registry + 连通性矩阵

**作者**: 通信工程马
**状态**: Draft v4 (通信牛 二次复判 — R1/R2 闭合 ✅, R3 doc 不一致补完)
**v4 变更说明**: 通信牛 二次复判 (通信龙 转 task 385b7316) — R1 redirect manual + R2 undici SNI pin **闭合 ✅**, 但 R3 文档自相矛盾必修:
- **§2.2 probe_results table** v3 留了 `error_message TEXT` (daemon-submittable 含义), v4 重命名为 `error_label` 并 schema-comment 明标「HUB-DERIVED ONLY, daemon CANNOT submit」, 加 §4.4.4 `deriveErrorLabel(ack)` 派生表 (从 status enum + raw_status_code 映射到 UI 文案)
- **§2.3 ack_probe_request 工具签名** v3 留了 `error_message?` 参数, v4 删除, 改成 `(probe_id, status, latency_ms, raw_status_code?)` + 注 white-list schema + 指向 §4.4.4 ProbeAckPayload zod 强制
- **impl 不变量**: grep `error_message` 在任何 daemon code path / hub code path 均应 0 命中 (字段重命名 + ack schema zod-validate 强制)

**v3 变更说明** (历史): 通信牛 SEC verdict (通信龙 转 [task 191eb7cb](https://github.com/sleep2agi/agent-network/pull/303)) — vault lazy gate / role gate / SEC-1 通过, **但 F1 SSRF 还有 3 处真实现坑**:
**v3 变更说明**: 通信牛 SEC verdict (通信龙 转 [task 191eb7cb](https://github.com/sleep2agi/agent-network/pull/303)) — vault lazy gate / role gate / SEC-1 通过, **但 F1 SSRF 还有 3 处真实现坑**:
- **R1 (redirect SSRF)**: v2 `fetch()` 默认 follow 30x — vendor 返 `Location: http://169.254.169.254/` 绕过 allowlist + IP check。修: `redirect:"manual"` + 3xx 一律 fail (probe minimal 不该需 redirect) (详 §4.4.2)
- **R2 (HTTPS pin 实现不成立)**: v2 `fetch("https://<pinned-ip>/", headers:{Host:...})` 错——HTTPS SNI/cert validation 用 URL hostname (= IP), 不是 Host header; 必 cert mismatch (或 worse: 误关 TLS check 反而通过) 修: 用 undici/Bun dispatcher + customLookup, **URL 保留 vendor hostname** (SNI + cert 校验正确), 网络 connect 走 pin IP; 显式 ban `NODE_TLS_REJECT_UNAUTHORIZED=0` / insecure TLS fallback (详 §4.4.2)
- **R3 (redact 还不够硬)**: v2 全文 replace 漏 URL-encoded (`sk%2Dant%2D...`) / 分段 / prefix-only echo 修: **daemon ack 只回白名单化 summary** (canonical_reason enum + status code, 不含 vendor 任意字符串字段); hub 二层 full-value + 常见 encoding 变体兜底 (详 §4.4.4)
- **vault lazy / role / SEC-1**: 通信牛 PASS 不动

**v2 变更说明** (历史): 通信龙 first-pass [task bbb9b3de](https://github.com/sleep2agi/agent-network/pull/303) PASS 方向 + 5 finding 全折:
**v2 变更说明**: 通信龙 first-pass [task bbb9b3de](https://github.com/sleep2agi/agent-network/pull/303) PASS 方向 + 5 finding 全折:
- **F1 (critical · SSRF)**: §4.4 「probe 不能任意 URL」措辞模糊 — base_url 主机 admin 自由填 = SSRF feature。三层堵: per-vendor host allowlist + daemon probe pre-fetch 私 IP 段拒 + DNS resolve 后再校验 IP (防 rebinding)。详 §4.4 重写 + §4.6 加 `probe_target_forbidden` / `probe_resolve_unsafe_ip`
- **F2 (重要 · 迁移)**: §4.1 master key 不能 hub-boot 无条件 require, 现有 hub 升 preview.3 即 boot fail 砸生产。改 lazy gate — vault 表空时 env 可缺失; 首次 upsert_secret OR 检测 providers 行时才 require + 清晰 migration 错。详 §4.1
- **F3 (重要 · redact)**: `redactSecrets` 必须 match secret **值**全文(vendor 错误回的是值), 不是 key 名。在 hub 端 ack_probe_request 入口跑 redact, daemon 不持密。详 §4.4
- **F4 (UX)**: §3.3 model 下拉「只显示 probe=ok」会让新 provider 空下拉。改三态 (✓ 已验 / ⚠️ 未验仍可选 + tooltip / ✗ 已知失败)。详 §3.1 + §3.3
- **F5 (doc note)**: P1 env var OK, 但 §7.1 必标 (a) master key 轮换 = re-encrypt 所有 secret (P3 工具) (b) env 永不进 log/ProcessTitle/crash dump。详 §7
- **§7 verdict 6 项全锁**: ①env P1 OK (with F2/F5) ②probe 成本 rate-limit+30s+dashboard 标 ≈$X ③per-vendor adapter ✓ ④vendor-canonical normalize ✓ ⑤in-flight 用旧 key P1 OK ⑥viewer 看列表 OK 但**永不见 key 值**
**关联**:
- #299/#260 — RFC-026 create-node (本 RFC 给它喂 model 来源)
- RFC-026 §4.4 secret vault — provider API key 复用 vault + mint-stream-evict 模式
- no-Max 中心 key 库 — fleet-scale 不用每节点单填 key
- #301 dashboard 真生效 umbrella
- 留 RFC-027 给 stop/delete (RFC-026 §5 P3 hook)
**目标 ship**: P1 MVP `v0.13-preview.X` 单 provider CRUD + 单 server 连通性测；P2/P3 后续
**长度承诺**: 该 RFC 限定 design，**任何代码改动不在本 RFC 内**

---

## 0. TL;DR

Vincent 推「预设模型功能」（loop 推进 3 功能之一）。今天 anet 节点的 model + provider key 是**每节点本地填**，fleet-scale 不可扩展（30 个节点 = 30 次手填 + 同步 key 漂移）。本 RFC 设计一条**集中 registry + secret vault + 服务器侧连通性测**的链路：

> **「Provider Registry」= hub 集中存的 provider (base_url + key + model list) + 「模型 × 服务器」可达矩阵 + 创建节点时下拉**。Dashboard CRUD providers / models；测试连通性按钮真打一次该 provider/model **在目标服务器 daemon 上**跑（网络环境不同，hub 替不了 daemon 的连通性结论）。RFC-026 create-node 的 model 字段从此 registry 拉。

**为什么选这个形态**：
- 复用 RFC-026 §4.4 mint-stream-evict secret vault → provider key 也是「永不进生产 DB 明文 / 永不入日志」同一套设计骨架
- 复用 RFC-026 create-node MCP 工具调用骨架 → 连通性测试 = daemon-side 新 tool `probe_provider_model`（hub 派单，daemon 在本机跑真请求，返结果）
- 复用 #299 daemon 的 SSE doorbell + ntok auth + W1 supervisor → 0 新基础设施
- registry 是 hub-side 元数据 + vault 是 hub-side 内存级 secret —— 与 RFC-026 / RFC-024 完全同形态，reviewer / impl 都不踩新石头

MVP（P1）只做单 provider CRUD + 单 server 连通性测（证 chain），P2 多 server matrix + 自动每天 cron probe，P3 用户自定义 model + provider 模板库。

---

## 1. 现状审计

### 1.1 RFC-026（create-node + secret vault）现状

| 能力 | 现状 | 给本 RFC 的价值 |
|---|---|---|
| `node_create_requests` 表 + create-node MCP 工具 | ✅ shipped #299 | 复用工具骨架；本 RFC 的 `probe_provider_model` daemon 工具走同一 SSE doorbell + ntok |
| §4.4 mint-stream-evict secret vault 设计 | ⚠️ 设计完成，**impl 推迟到 P2**（#299 只把 `secret_not_in_vault` 错误码留好了 hook） | **本 RFC 把 vault impl 提前**——provider key 是它的第一个真用户；P1 落地 vault 同时服务 RFC-026 P2 |
| daemon role=host_supervisor + 派单 + 双层校验 | ✅ shipped | probe 工具是新 daemon-side tool，role/network/token-bound 全复用 §4.1.4 |
| §4.4.8 orphan ntok revoke sweeper | ✅ shipped | probe 也可能产生短命 token；同 sweeper 接管 |

**结论**：RFC-026 留的 vault hook + create-node 骨架是本 RFC 的脚手架，重写 0，新增主要 = 1 张表 + 2 MCP 工具 + 1 daemon-side tool + dashboard 1 个新页。

### 1.2 RFC-026 §4.4 vault 的 P1 简化（要在本 RFC 接管落地）

RFC-026 P1 因「dashboard UI 没接 vault」把 vault 暂时简化为「`networkSecretsGet: () => undefined`」，所有 `env_refs` 都返 `secret_not_in_vault`。本 RFC 把 vault 的 impl 提前——provider API key 就是 vault 的第一个真用户。RFC-026 P2 接 vault 时只需把 `networkSecretsGet` 接到本 RFC 加的 `network_secrets` 表（同一份 DB schema）。

### 1.3 现在 model + provider 是怎么填的

```
anet node create <name>
  → wizard 问 vendor (VENDORS enum: anthropic/openai/zai/openrouter/...)
  → wizard 问 base URL (per vendor 默认)
  → wizard 问 API key (env var name 或裸 string)
  → wizard 问 model (per vendor 默认列表)
  → 写 .anet/nodes/<name>/config.json
```

每节点独立填。fleet 场景下：
- 30 个节点 = 30 次手填同一 ANTHROPIC_API_KEY
- key 轮换 = 30 个节点逐个改
- 加新 model = 30 次同步
- 不知道某 model 在哪些 server 能通（无网络可达矩阵）

本 RFC 把这些从「节点本地填」迁到「dashboard CRUD + 派下放」。

---

## 2. 架构

### 2.1 总览

```
┌────────────┐   utok     ┌────────┐
│  Dashboard │ ─────────► │  Hub   │
└────────────┘  provider  └────────┘
   CRUD             │
   probe-btn        │
                    ▼
          ┌─────────────────────────┐
          │  hub-side state         │
          ├─────────────────────────┤
          │ providers (DB)          │
          │ models    (DB)          │
          │ network_secrets (DB,    │
          │   encrypted-at-rest)    │
          │ probe_results (DB)      │
          │ pendingSecretBlobs Map  │  ← F1 mint-stream-evict
          │   (RFC-026 §4.4 复用)    │
          └─────────────────────────┘
                    │
                    │ SSE { type: probe_provider }
                    ▼
          ┌─────────────────────────┐
          │ Daemon (role=           │
          │  host_supervisor)        │
          ├─────────────────────────┤
          │ MCP tool:                │
          │  probe_provider_model    │
          │   - pull spec + secret   │
          │   - fetch(base_url, ...) │
          │     真打一次             │
          │   - ack(latency/ok/err)  │
          └─────────────────────────┘
                    │
                    ▼
          probe_results 表 (model × server × ts)
          → dashboard 渲染矩阵
```

### 2.2 数据模型（hub 新增）

```sql
-- §2.2.1 providers — dashboard CRUD 主对象
CREATE TABLE providers (
  provider_id    TEXT PRIMARY KEY,         -- prov_<uuid>
  network_id     TEXT NOT NULL,            -- 多租户隔离
  name           TEXT NOT NULL,            -- "Anthropic 主账号" 等友好名
  vendor         TEXT NOT NULL,            -- enum: anthropic/openai/zai/openrouter/deepseek/qwen/...
  base_url       TEXT NOT NULL,            -- e.g. https://api.anthropic.com/v1
  secret_key_ref TEXT NOT NULL,            -- 指向 network_secrets.key 名 (FK by name)
  created_at     INTEGER NOT NULL,
  created_by     TEXT NOT NULL,            -- user_id
  enabled        INTEGER NOT NULL DEFAULT 1,
  UNIQUE(network_id, name)
);
CREATE INDEX idx_providers_network ON providers(network_id);

-- §2.2.2 models — 每 provider 下的可用 model 清单
CREATE TABLE provider_models (
  model_id        TEXT PRIMARY KEY,        -- pm_<uuid>
  provider_id     TEXT NOT NULL REFERENCES providers(provider_id),
  model_name      TEXT NOT NULL,           -- e.g. "claude-opus-4-6"
  display_name    TEXT,                    -- e.g. "Claude Opus 4.6"
  context_window  INTEGER,                 -- 200000 等 (meta)
  supports_vision INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  UNIQUE(provider_id, model_name)
);
CREATE INDEX idx_models_provider ON provider_models(provider_id);

-- §2.2.3 network_secrets — provider key 的真存储 (复用 RFC-026 §4.4 vault)
--    encrypted-at-rest (AES-GCM with hub-level master key from env);
--    plaintext value 仅在 hub 进程内存出现, 走 mint-stream-evict 派下去
CREATE TABLE network_secrets (
  network_id   TEXT NOT NULL,
  key          TEXT NOT NULL,              -- e.g. "ANTHROPIC_API_KEY"
  ciphertext   BLOB NOT NULL,              -- AES-GCM encrypted
  iv           BLOB NOT NULL,
  tag          BLOB NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (network_id, key)
);
-- 不索引 ciphertext (整列加密, 索引无意义)

-- §2.2.4 probe_results — 连通性测试历史 / 矩阵渲染源
CREATE TABLE probe_results (
  probe_id        TEXT PRIMARY KEY,
  provider_id     TEXT NOT NULL,
  model_name      TEXT NOT NULL,
  daemon_node_id  TEXT NOT NULL,           -- 哪台 server 上跑的
  network_id      TEXT NOT NULL,
  -- v3 R3: status is one of a fixed enum (see §4.4.4 ProbeAckPayload).
  -- daemon NEVER submits a raw error string; hub derives the human label
  -- from (status, raw_status_code) and stores it as a frozen view.
  status          TEXT NOT NULL,           -- pending/ok/auth_fail/quota/rate_limit/network_error/timeout/redirect_forbidden/vendor_5xx/other_4xx/tls_error
  latency_ms      INTEGER,
  -- error_label is HUB-DERIVED ONLY, mapped from (status, raw_status_code)
  -- via a static lookup table (§4.6 error catalog row → UI 文案 column).
  -- daemon CANNOT submit this; hub fills it. Naming changed from
  -- v2's `error_message` to make the "no daemon-submittable string"
  -- invariant impossible to misread. Grep `error_message` in impl-time
  -- source should yield 0 hits in any daemon-facing code path.
  error_label     TEXT,
  probed_at       INTEGER NOT NULL,
  probed_by_user  TEXT,                    -- audit
  raw_status_code INTEGER                  -- 200/401/403/429/500 etc, audit
);
CREATE INDEX idx_probe_matrix ON probe_results(network_id, provider_id, model_name, daemon_node_id, probed_at DESC);
```

### 2.3 MCP 工具（hub-side, 2 new + 复用 RFC-026 SSE doorbell）

**hub-side (dashboard-facing)**:

1. `upsert_provider(name, vendor, base_url, secret_key, models[])` — CRUD provider
2. `delete_provider(provider_id)` — soft delete (enabled=0; hard-delete reserved P2)
3. `list_providers()` — return providers + models in caller network
4. `upsert_network_secret(key, value)` — vault write (encrypts at rest); SEC-1 admin-only
5. `probe_provider_model(provider_id, model_id, daemon_node_id)` — dispatch probe to daemon
6. `get_probe_results(provider_id?, model_id?, daemon_node_id?)` — query matrix

**daemon-side (hub-facing)** (新增 RFC-026 工具集):

7. `get_probe_request(probe_id)` — daemon pulls full spec + ephemeral secret + base_url
8. `ack_probe_request(probe_id, status, latency_ms, raw_status_code?)` — **v3 R3 white-list schema**, NO arbitrary string field (no `error_message` / `error` / `detail` / `vendor_text`). See §4.4.4 `ProbeAckPayload` for the canonical zod schema; hub `rejectIfSecretLeaked` enforces.

`probe_provider_model` 把任务派给 daemon (SSE doorbell type=`probe_provider`)，daemon 在本机用 `fetch(base_url, ...)` 真发一次 minimal probe 请求（hello / `/models` GET / vendor-specific tiny call），返结果。**daemon 永远不存 key**，只在本次 fetch 时内存里用一次。

### 2.4 probe 派单流程（mint-stream-evict 复用）

1. Dashboard 点「测试 Anthropic / claude-opus-4-6 在 daemon-server-A 上」
2. Hub `probe_provider_model`:
   - SEC-1: caller network == provider.network_id == daemon.network_id
   - SEC-2: admin+ role (改 vault 关联是高权限动作)
   - 从 vault 解密 secret → pendingProbeSecrets Map (TTL 60s)
   - 写 `probe_results` row status=`pending` (无 secret，只有 model+daemon refs)
   - SSE push daemon: `{type:"probe_provider", probe_id}`
3. Daemon 收到 → `get_probe_request(probe_id)` → 拿 base_url + secret + spec
4. Daemon 真 `fetch(base_url + "/v1/messages" or "/models", ...)` (vendor 适配 minimal probe)
5. Daemon `ack_probe_request(probe_id, "ok", latency_ms=180)` → hub UPDATE probe_results
6. Dashboard 轮 `get_probe_results` → 矩阵格子变绿/红/黄

---

## 3. Dashboard UI

### 3.1 Providers 管理页

```
┌─────────────────────────────────────────────────────────────────┐
│  Provider & Model Registry — net_xxx                            │
├─────────────────────────────────────────────────────────────────┤
│  + New Provider                                                  │
│  ┌────────────────────────────────────────────────────────┐     │
│  │ Anthropic 主账号 (anthropic)        [edit] [del]        │     │
│  │  base: https://api.anthropic.com/v1                      │     │
│  │  key:  ANTHROPIC_API_KEY  [in vault ✓]                   │     │
│  │  Models:                                                  │     │
│  │   • claude-opus-4-6 (200K ctx)     [test all servers]    │     │
│  │   • claude-sonnet-4-6              [test all servers]    │     │
│  │   + Add Model                                             │     │
│  └────────────────────────────────────────────────────────┘     │
│  + Add Model           Reachability matrix ↓                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              server-A     server-B     local-laptop        │  │
│  │ claude-opus  ✓ 180ms     ✓ 220ms      ✗ network_err       │  │
│  │ claude-sonn  ✓ 150ms     ✗ 401        ⚠️ 未验证              │  │  ← v2 F4 三态
│  │ gpt-4o       ⚠️ 未验证    ⚠️ 未验证    ✓ 250ms              │  │
│  └───────────────────────────────────────────────────────────┘  │
│  [Probe all] — 每次 ≈ $0.0001 (anthropic minimal) · rate-limited│  ← v2 §7.2 cost note
└─────────────────────────────────────────────────────────────────┘
```

格子状态 (per cell):
- ✓ green + latency = probe ok (含 ms)
- ✗ red + 简短 reason = probe failed (`401` / `429` / `network_err` / `timeout`)
- ⚠️ amber + 「未验证」= 该 (provider, model, daemon) 三元组从未 probe 或 probe 太旧 (>7d)

cost label 永显示在 [Probe all] 按钮下, vendor adapter 报告 minimal cost (anthropic 1 token in/out ≈ $0.0001, openai ≈ $0.0002), 矩阵 UI 顶部汇总当次 probe 预估总成本 (m * n grid → m × n × per-call cost).

### 3.2 Provider CRUD 流程

- **Add Provider**: form (name / vendor enum / base_url / key) — key 字段是 vault picker（不接受裸值写入；如要新加 key 走单独的 vault 管理子页）
- **Add Model**: form (model_name / display_name / context_window / supports_vision)
- **Test connectivity**: 点 [test all servers] 按钮 → 对该 network 在线的每个 daemon 派一发 probe → 3-10s 矩阵更新

### 3.3 喂给 create-node #299 的 model 下拉（v2 F4 三态 fallback）

`create_node` 工具的 `model` 字段原本接 user-typed string。本 RFC 后：

- dashboard create-node wizard step 2 「Runtime + Model」：runtime 不变，model 改成下拉
- 用户选了后 `node_spec.model` 还是 string；dashboard 也额外传 `provider_id` → hub 在 create_node 内部把 vault key 关联进 env_refs（复用 RFC-026 §4.4.7 流程）

**v2 F4 修**: v1 写「仅显示 probe=`ok` 的 model」会让**新加 provider 空下拉**（还没 probe 矩阵就空 → 创建不了节点）。改成 **三态**:

| 状态 | matrix 值 | UI | 用户能选吗 |
|---|---|---|---|
| ✓ 已验通 | probe `ok` | 绿色 model 名 + latency tooltip (`180ms`) | ✅ |
| ⚠️ 未验证 | probe 缺失 (新加 / 从未 probe) | 灰色 model 名 + tooltip「未验证 — 建议先在 [Provider 页] 跑测试」 | ✅ (允许, 但带 warning banner: 「未验证 model, 节点可能首调失败」) |
| ✗ 已知失败 | probe `auth_fail` / `quota` / `network_error` | 红色 model 名 + tooltip 错原因 (e.g. `401 auth_fail`) | ⚠️ 仍可选但 default disabled, 用户须勾「强制使用 (debug)」 checkbox 才能 submit |

理由: provider 刚加完到首次 probe 之间的窗口不能让用户卡死; 但失败 model 也不能 silently 当好的卖。新建节点页打开时 dashboard 后台**自动派一个该 daemon 上的 probe** (asyc, 不阻塞 UI), 用户提交时如已有结果展示, 没结果按「未验证」处理。

---

## 4. 安全边界

**provider key 是高价值目标**——一个 key 漏 = 整个 fleet 烧账单。安全规则比 create-node 更紧。

### 4.1 vault 落地（RFC-026 §4.4 接管 — v2 F2 lazy gate）

- **encrypted-at-rest**: `network_secrets` 表 BLOB 列存 AES-GCM 密文，master key from `ANET_HUB_SECRET_VAULT_KEY` env var；key 32 bytes hex
- **plaintext lifetime**: 解密只发生在 (a) vault 写入时 enc / 读出时 dec，(b) probe/create-node 派单瞬间 mint-stream-evict
- **DB 备份/快照里只有密文**: master key 不在 DB
- **`secret_key` 字段 dashboard 永远写「key 名」不写「key 值」**：UI 永不直接接受 textfield；强制走单独「Secret Vault」管理子页才能写 key 值
- **key 列出去时只回 key 名 + 是否在 vault**：list_providers 返 `{ secret_key_ref: "ANTHROPIC_API_KEY", in_vault: true }`，永不返值

**v2 F2 master key lazy gate**（不能 hub-boot 无条件 require）：

v1 写「缺 env → exit」是个**升级炸弹**——通信龙 catch: 生产 hub 升 preview.3 时该 env 不在, hub 全 boot fail = 砸生产。改成 **lazy gate**:

```ts
// hub boot 时 NOT require
let _masterKey: Buffer | null = null;
function getVaultMasterKey(): Buffer {
  if (_masterKey) return _masterKey;
  const hex = process.env.ANET_HUB_SECRET_VAULT_KEY;
  if (!hex) {
    throw new Error(
      `vault_master_key_missing: ANET_HUB_SECRET_VAULT_KEY env var not set. ` +
      `Generate one: openssl rand -hex 32. ` +
      `Add to systemd unit Environment= or .env. Required only when using ` +
      `provider/secret features (this hub has providers or network_secrets ` +
      `rows present, so it's now required).`
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("vault_master_key_invalid: must be 32 bytes hex");
  _masterKey = Buffer.from(hex, "hex");
  return _masterKey;
}

// Only callers actually using vault hit this: upsert_network_secret,
// upsert_provider (refs secret), probe (decrypts), create_node (env_refs).
// Hubs that never touch providers/secrets boot + run normally without the env.
```

**Migration 行为**:
- 现有 hub 升 preview.3 不强制设 env → 正常 boot ✓ (`providers` + `network_secrets` 表空)
- 首次 dashboard 调 `upsert_network_secret` 或 `upsert_provider` → 抛 `vault_master_key_missing` 错 (admin 看到清晰提示, 一次性配 env + restart)
- 已配 env 但删了 env 且 vault 表有数据 → 启动后任何 vault op 抛同错; **现有 hub 安全行为不变** (没动 env = 没 vault feature = 安全 fallback)
- hub 启动 banner 加一行 vault status: `vault: configured (env set)` 或 `vault: disabled (env not set; provider/secret features unavailable)` — operator 一目了然

**P2 升级路径**: `ANET_HUB_SECRET_VAULT_KEY` env → systemd-creds (Linux prod) → hashicorp vault adapter (商业版话题)

### 4.2 谁能改 (role gate)

| 动作 | 最低 role | 理由 |
|---|---|---|
| list_providers / get_probe_results | viewer | 只读 |
| upsert_network_secret | **owner** | vault 写 = 信任根, owner-only |
| upsert_provider / delete_provider | admin | 改 fleet 配置 |
| upsert_model (add/del 行) | admin | 同上 |
| probe_provider_model | admin | 真打 API = 烧账单 |

非 admin user 在 dashboard 看到 "🔒 owner only" 灰按钮（hub 端校验，UI 是辅助）。

### 4.3 跨租户隔离（SEC-1）

- `providers.network_id` / `network_secrets.network_id` / `probe_results.network_id` 全在主键里
- 所有读/写都 `AND network_id = caller_net` 防护带（同 RFC-024/026）
- daemon 派单时 SEC-1 check: `provider.network_id == daemon.network_id == caller.network_id` 三方等
- vault key 名空间是 network-local: netA 的 `ANTHROPIC_API_KEY` 跟 netB 同名是两份独立 secret

### 4.4 daemon 侧 (probe 工具的特殊红线 — v2 F1 SSRF 三层堵 + F3 redact)

> **v1 写「probe 不能任意 URL」措辞模糊**: 只 enforce vendor enum 决定 endpoint path，但 `provider.base_url` 主机是 admin **自由填**——被盗 admin token 或恶意 admin 可让 daemon 替它 fetch 内网 (10./192.168./127./169.254.169.254 cloud metadata)。这是把 SSRF 当 admin feature。v2 三层堵:

**4.4.1 per-vendor host allowlist (静态 enum)**

```ts
const VENDOR_HOST_ALLOWLIST: Record<string, ReadonlyArray<RegExp>> = {
  anthropic:  [/^api\.anthropic\.com$/],
  openai:     [/^api\.openai\.com$/],
  zai:        [/^api\.z\.ai$/, /^open\.bigmodel\.cn$/],
  openrouter: [/^openrouter\.ai$/],
  deepseek:   [/^api\.deepseek\.com$/],
  qwen:       [/^dashscope(-intl)?\.aliyuncs\.com$/],
  // custom: 极严 — 必须 admin 在 dashboard 显式 allowlist 个别 host
  //         (不在本 RFC P1, P3 上)
};

function validateBaseUrl(vendor: string, baseUrl: string): void {
  const u = new URL(baseUrl);
  // §4.4.2 https-only (本地 dev exception 在 §4.4.3 + IP-check 双闸)
  if (u.protocol !== "https:" && !isLoopbackHost(u.hostname)) {
    throw new ValidationError("probe_base_url_invalid", { reason: "must be https" });
  }
  const allowed = VENDOR_HOST_ALLOWLIST[vendor];
  if (!allowed) throw new ValidationError("vendor_not_supported", { vendor });
  if (!allowed.some(re => re.test(u.hostname))) {
    throw new ValidationError("probe_target_forbidden", {
      vendor, host: u.hostname, allowed: allowed.map(r => r.source),
    });
  }
}
```

hub-side `upsert_provider` 入口 + daemon-side `get_probe_request` 收到后 **双层** 跑 `validateBaseUrl`。即使 hub 派进来的 spec 已被改 host (compromised hub 也假设), daemon 不信。

**4.4.2 daemon probe pre-fetch IP 校验 (anti private-IP)**

```ts
import { promises as dns } from "node:dns";
import { isIP } from "node:net";

// CIDR-style 私网 / 保留 / metadata 段全拒
const FORBIDDEN_IPV4 = [
  /^10\./, /^127\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,            // link-local + 169.254.169.254 cloud metadata
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,  // CGNAT
  /^0\./,                    // 0.0.0.0/8
  /^22[4-9]\.|^23[0-9]\./,  // multicast
  /^24[0-9]\.|^25[0-5]\./,  // experimental
];
const FORBIDDEN_IPV6 = [
  /^::1$/, /^::$/,
  /^fe80::/i, /^fc00::/i, /^fd00::/i, // ULA + link-local
  /^::ffff:/i,                          // IPv4-mapped IPv6 (recheck via .replace)
];

function isForbiddenIp(ip: string): boolean {
  if (isIP(ip) === 4) return FORBIDDEN_IPV4.some(re => re.test(ip));
  if (isIP(ip) === 6) {
    // IPv4-mapped: ::ffff:10.0.0.1 → recheck against IPv4 list
    if (ip.toLowerCase().startsWith("::ffff:")) {
      return isForbiddenIp(ip.slice(7));
    }
    return FORBIDDEN_IPV6.some(re => re.test(ip));
  }
  return true;  // unknown family → reject
}

// dev/test loopback exception: ONLY when ANET_DAEMON_PROBE_ALLOW_LOOPBACK=1
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

// v3 R1+R2 — boot-time guard: explicitly forbid insecure TLS env. If
// any of these are set when daemon starts, exit with anet_tls_insecure_disabled.
function assertSecureTlsEnv(env: NodeJS.ProcessEnv): void {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("probe_tls_insecure_disabled: NODE_TLS_REJECT_UNAUTHORIZED=0 forbidden — TLS cert validation must be ON for SSRF defense");
  }
  // Other insecure TLS vectors we explicitly check: --insecure-tls / Bun's TLS bypass; impl note: add CI lint
  // 'grep "rejectUnauthorized:.*false"' across daemon source = 0 hits.
}

// v3 R2 — custom DNS lookup pins to pre-validated IP; URL keeps the
// original vendor hostname so SNI + TLS cert validation see the vendor's
// name (not the raw IP). undici Agent dispatcher + connect.lookup is the
// portable hook (Bun fetch is undici-compatible).
import { Agent, fetch as undiciFetch } from "undici";

async function safelyFetchProbe(baseUrl: string, env: NodeJS.ProcessEnv): Promise<Response> {
  assertSecureTlsEnv(env);
  const u = new URL(baseUrl);

  // ① resolve all A/AAAA records (anti single-record cherry-pick)
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (addrs.length === 0) {
    throw new ValidationError("probe_resolve_unsafe_ip", { host: u.hostname, reason: "no records" });
  }
  // ② every resolved IP must pass forbidden-check
  for (const a of addrs) {
    if (isForbiddenIp(a.address)) {
      if (isLoopbackHost(u.hostname) && env.ANET_DAEMON_PROBE_ALLOW_LOOPBACK === "1") continue;
      throw new ValidationError("probe_resolve_unsafe_ip", { host: u.hostname, ip: a.address });
    }
  }
  const pinIp = addrs[0].address;
  const pinFamily = addrs[0].family;

  // ③ R2 — undici dispatcher with custom lookup. URL stays
  //    https://api.anthropic.com/... so the TLS layer sees the vendor's
  //    hostname (SNI + cert SAN/CN validation correct); the network
  //    connection actually goes to pinIp (anti DNS-rebinding).
  //
  //    CRITICAL: dispatcher uses ONLY OUR pinned lookup; system DNS is
  //    never re-consulted between this point and fetch send.
  const pinnedDispatcher = new Agent({
    connect: {
      lookup(_hostname: string, _opts: any, cb: (err: Error | null, addr: string, family: number) => void) {
        cb(null, pinIp, pinFamily);
      },
      // Hardened TLS: minimum TLS 1.2, no insecure ciphers, explicit
      // rejectUnauthorized=true (not opt-out)
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    },
    bodyTimeout: 30_000,
    headersTimeout: 30_000,
  });

  // ④ R1 — manual redirect handling. fetch() default follows 3xx silently,
  //    letting vendor return `Location: http://169.254.169.254/` bypass our
  //    allowlist + IP check. P1: 3xx is a hard fail (probe minimal call
  //    should never redirect; if a future vendor adapter genuinely needs
  //    redirect, it gets per-vendor explicit allow + re-runs full validate
  //    on Location URL).
  const resp = await undiciFetch(baseUrl, {
    method: "POST",                         // vendor adapter decides; here illustrative
    headers: { /* vendor adapter sets auth + body */ },
    redirect: "manual",                     // NEVER follow auto
    dispatcher: pinnedDispatcher,
    signal: AbortSignal.timeout(30_000),
  }) as unknown as Response;

  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get("location") || "(no header)";
    throw new ValidationError("probe_redirect_forbidden", {
      status: resp.status,
      location_truncated: loc.slice(0, 100),  // truncated for log safety
    });
  }
  return resp;
}
```

**关键不变量** (v3):
- URL hostname **永远是 vendor 域名**, TLS SNI + cert SAN validation 正常
- 网络连接 **永远走 pin IP** (custom lookup), DNS rebinding window = 0 (lookup 只调用一次, 之后用 dispatcher 内 cache 直连)
- `redirect: "manual"`, 3xx 一律 fail (`probe_redirect_forbidden`)
- `rejectUnauthorized: true` 显式 set (不靠 default); TLS 最低 1.2
- daemon boot 时 `assertSecureTlsEnv` 检 `NODE_TLS_REJECT_UNAUTHORIZED=0` 等环境变量, 见到 exit; **CI lint guard** 检 daemon 源码 `rejectUnauthorized:.*false` / `tls.checkServerIdentity.*noop` / 等 pattern = 0 命中

**P1.5 implementation note (#310, 2026-08-09):** production no longer
selects one illustrative `pinIp`. `createPinnedLookup(host, addrs)` retains the
whole pre-validated A/AAAA set, honors undici/Node's single-address,
`family`, and `{all:true}` callback forms, and rejects a different hostname or
an unavailable family with `ENOTFOUND`. It never falls back to system DNS.
The URL remains the vendor hostname, so SNI and certificate SAN validation are
unchanged. `test648-probe-ip-pin` runs a split-horizon real TLS test under both
Node 20 and Bun: pre-validation returns `127.0.0.1`, system DNS returns
`127.0.0.2`, and only the validated endpoint may receive the request.

**关键不变量**:
- DNS 解析 → 校验 IP → 用 IP 直连 fetch 三步原子, **rebinding window 为 0** (解析后立即固定 IP)
- IPv4-mapped IPv6 二次校验, 防 `::ffff:10.0.0.1` 绕 v6 list
- loopback dev exception 需 explicit env, 默认 deny
- 校验失败 = `probe_resolve_unsafe_ip` 错误码 + audit log (含 resolved IP), 不 fetch 一字节

**4.4.3 其它红线 (v1 保留)**

- **probe 请求 size 上限**: 1KB request body, 防 daemon 被劫持发 massive payload
- **timeout 强制 ≤ 30s**: `AbortSignal.timeout(30_000)` 已在 §4.4.2 fetch 内强制
- **rate limit per provider**: hub-side 每 (provider_id, model_id, daemon_node_id) 三元组 60 req/min 上限 (反向防 DoS 给 vendor + 防滥点 §7.2 烧 token 风险)

**4.4.4 error 路径 — daemon 白名单 ack + hub 二层 redact + hub-derived error_label (v3 R3)**

v2 写「hub 端全文 replace match secret 值」**还不够硬**——通信牛 catch:
- URL-encoded 变体: vendor 错误可能编码 `Invalid API key: sk%2Dant%2Dabc...`
- 分段 echo: 错误信息可能拆开 (`Got "sk-ant-" prefix but expected... abc... suffix doesn't match`)
- prefix/suffix-only echo: `Invalid API key starting with sk-ant- (last 4: abc1)` —— 部分明文照样可拼回

正解: **daemon ack 一开始就不传 vendor raw text 给 hub**。

**daemon 侧 `ack_probe_request` payload schema (P1 严格白名单)**:

```ts
// daemon-side — what daemon sends to hub. No `error: string` 字段
// 任意字符串. Only canonical enum + numeric code + duration.
interface ProbeAckPayload {
  probe_id: string;
  status: "ok"
        | "auth_fail"          // HTTP 401 / 403 with vendor auth-like wording
        | "quota"              // HTTP 429
        | "rate_limit"         // 429 from our pinned dispatcher (rare)
        | "network_error"      // connect/DNS/TLS fail (NOT vendor 5xx)
        | "timeout"            // 30s ceiling hit
        | "redirect_forbidden" // 30x — locked
        | "vendor_5xx"         // 500-599 from vendor (allowlist'd host so safe to label)
        | "other_4xx"          // 400/404/etc — vendor-specific but no secret
        | "tls_error";         // cert validation fail (post-dispatcher)
  raw_status_code?: number;    // numeric only, e.g. 401/429/500
  latency_ms: number;
  // NB: NO `error_message` string field. NO `response_body`. NO
  // `response_headers`. NO `url`. daemon classifies via response shape
  // (status + content-type + tiny canonical-string match) and discards
  // raw text before sending.
}

// daemon-side classifier — vendor adapter maps real response shape →
// enum. Only allowlisted classification strings get touched (not echoed):
function classifyProbeResponse(resp: Response, latencyMs: number, vendor: string): ProbeAckPayload {
  const code = resp.status;
  let status: ProbeAckPayload["status"];
  if (code === 200 || code === 201) status = "ok";
  else if (code === 401 || code === 403) status = "auth_fail";
  else if (code === 429) status = "quota";
  else if (code >= 300 && code < 400) status = "redirect_forbidden";
  else if (code >= 500 && code < 600) status = "vendor_5xx";
  else if (code >= 400) status = "other_4xx";
  else status = "network_error";  // shouldn't happen post-dispatcher OK
  return { probe_id, status, raw_status_code: code, latency_ms: latencyMs };
}
```

`network_error` / `timeout` / `tls_error` 由 try/catch 包 fetch 异常映射, **从不**传 vendor 字符串。

**hub-side `error_label` derivation (v3 R3 — daemon-text-free path)**:

`probe_results.error_label` 字段 (§2.2) 是**纯 hub-derived**, 从 `(status, raw_status_code)` 经 static lookup 算出, daemon 永不提交。impl-time hub-only 函数:

```ts
// hub-side ONLY — runs in ack_probe_request handler after rejectIfSecretLeaked passes
function deriveErrorLabel(ack: ProbeAckPayload): string | null {
  switch (ack.status) {
    case "ok":                   return null;
    case "auth_fail":            return `API key 校验失败 (HTTP ${ack.raw_status_code ?? "?"})`;
    case "quota":                return "API 额度用尽 (429)";
    case "rate_limit":           return "我方 rate limit (60req/min/provider) 触发";
    case "network_error":        return "网络不可达 (connect/DNS fail)";
    case "timeout":              return "连通性测试超时 (>30s)";
    case "redirect_forbidden":   return "vendor 返回 30x redirect, P1 一律拒";
    case "vendor_5xx":           return `vendor 服务端错 (HTTP ${ack.raw_status_code ?? "5xx"})`;
    case "other_4xx":            return `vendor 客户端错 (HTTP ${ack.raw_status_code ?? "4xx"})`;
    case "tls_error":            return "TLS 证书校验失败";
  }
}
```

**impl 不变量**: `INSERT INTO probe_results (error_label, ...) VALUES (deriveErrorLabel(ack), ...)`; daemon-facing schema 永不接 `error_message` 类字段。impl-time grep `error_message` 在 daemon code path 应 0 命中, 在 hub code path 也应 0 命中 (字段名已重命名为 `error_label` + 明文 hub-derived only)。

**hub-side 二层 redact (作 belt-and-suspenders, P1 已挡, P2 加更猛 redact when audit need raw)**:

`ack_create_request` 入口的 ProbeAckPayload **schema-validate** (zod), 拒任何额外字段 (避免攻击者 client 偷塞 `error_message` 字段进 hub log/DB)。审计需要更细的失败原因时, P2 加一个 daemon-side opt-in `verbose=admin-only` mode (返一个**预先 redacted 的 hash** 而非 raw text); P1 暂不需要 (status + raw_status_code 足够 dashboard 渲染矩阵).

**hub-side full-value redact (P1 兜底, 防 daemon 实现 bug)**:

```ts
// hub-side, processing ack — even though daemon doesn't send raw text,
// we run a guard: if any string field of ack contains a secret value
// (or its url-encoded / short-window variant), reject + audit. Daemon
// implementation bug catch.
function rejectIfSecretLeaked(ack: any, knownSecrets: string[]): void {
  const json = JSON.stringify(ack);
  for (const s of knownSecrets) {
    if (s.length < 8) continue;  // avoid false positive
    if (json.includes(s)) throw new Error("ack_secret_leak: daemon ack contained secret value (denied)");
    if (json.includes(encodeURIComponent(s))) throw new Error("ack_secret_leak: ack contained URL-encoded secret (denied)");
    // short-window: any 12-char substring of secret in payload = suspect
    if (s.length >= 16) {
      for (let i = 0; i <= s.length - 12; i++) {
        if (json.includes(s.slice(i, i + 12))) throw new Error("ack_secret_leak: ack contained secret substring (denied)");
      }
    }
  }
}
```

triggered = audit_log `secret_leak_from_daemon` row + drop ack (probe row stays `pending` until reaper). P1 此 guard 跑在 hub 处理 ack 第一步。

audit_log 写时仍用 status + raw_status_code (无 raw text), 永不存 vendor 输出原文。

**4.4.5 daemon 不接受任意 endpoint path / arbitrary HTTP method**

每 vendor adapter (vendor → 一个 probe 函数) **硬编码** HTTP method + path + minimal body, 不接受 hub 派进来的 endpoint 字段。例如 anthropic adapter 写死 `POST /v1/messages` body `{model, max_tokens:1, messages:[{role:"user",content:"."}]}`。spec 字段只含 model + provider_id; hub 不传 path / method / body。

### 4.5 audit

每 vault 改写 / provider 增删 / probe 触发 都写 `audit_log` 行 (复用 RFC-024/026 audit_log 表):
- vault_secret_upserted (action, network_id, key (名字), user_id, ip)
- provider_upserted / provider_deleted / model_upserted
- probe_triggered (with: provider_id, model_id, daemon_node_id, latency, status)

dashboard admin-only audit page 直查 (P2)。

### 4.6 error catalog

| code | 来源 | UI 文案 |
|---|---|---|
| `vault_master_key_missing` | hub boot | hub 启动 fail-fast，dashboard 不参与 |
| `secret_owner_only` | hub | 「修改 secret 需要 owner 权限」 |
| `provider_not_found` / `model_not_found` | hub | 「provider/model 不存在或已删除」 |
| `vendor_not_supported` | hub | 「不支持的 vendor: <name>，目前支持: …」 |
| `probe_base_url_invalid` | daemon | 「base_url 必须 https 或本地 http」 |
| `probe_request_timeout` | daemon | 「连通性测试超时 (>30s)」 |
| `probe_auth_fail` | daemon | 「API key 校验失败 (401)」 |
| `probe_quota_exhausted` | daemon | 「API 额度用尽 (429)」 |
| `probe_network_error` | daemon | 「网络不可达：<server> → <base_url>」 |
| `probe_rate_limit_local` | hub | 「该 provider 每分钟最多 60 次连通测试」 |
| `probe_target_forbidden` (v2 F1) | hub + daemon | 「base_url host 不在该 vendor 的 allowlist 内: <host>」 |
| `probe_resolve_unsafe_ip` (v2 F1) | daemon | 「base_url 解析到禁用 IP 段 (私网/metadata): <ip>」 |
| `vault_master_key_missing` (v2 F2, lazy) | hub (lazy gate) | 「ANET_HUB_SECRET_VAULT_KEY 未配置, 但本 hub 已有 vault 数据 — 请配置后重启」 |
| `vault_master_key_invalid` (v2 F2) | hub | 「ANET_HUB_SECRET_VAULT_KEY 必须 32 bytes hex (`openssl rand -hex 32`)」 |
| `probe_redirect_forbidden` (v3 R1) | daemon | 「probe 收到 3xx redirect, P1 一律拒绝 (location 已截断 100 字)」 |
| `probe_tls_insecure_disabled` (v3 R2) | daemon boot | daemon 启动 fail-fast: 检测到 NODE_TLS_REJECT_UNAUTHORIZED=0 等不安全 TLS env |
| `ack_secret_leak` (v3 R3) | hub | daemon ack 含 secret 值/编码变体/短窗 substring → 拒 + audit (daemon impl bug 信号) |

---

## 5. 分阶段

### P1 MVP — 单 provider CRUD + 单 server probe (ETA ~3-4d 工程)

**目标**: 证 chain，dashboard 创建第一个 provider + 真打 probe + 矩阵显示。

- DB schema 4 表 + vault 加密层 (AES-GCM with master key env)
- hub-side: upsert_provider / list_providers / upsert_network_secret / probe_provider_model / get_probe_results (5 个 MCP 工具)
- daemon-side: get_probe_request + ack_probe_request + probe fetch impl (per vendor, P1 只接 anthropic)
- dashboard: provider 管理页 (form + 单 provider 单 model probe button)
- create-node #299 model 下拉切到 list_providers 源
- e2e: 4 scenario (vault write + provider CRUD + probe ok + probe auth_fail)

**P1 不做** (但留 hook):
- 多 vendor (P2 接 openai/zai/openrouter/deepseek/qwen)
- 矩阵 cron 每天自动 probe
- audit 页

**ship**: v0.13-preview.X，docs 标 EXPERIMENTAL

### P2 — 多 vendor + reachability matrix UI + cron probe (ETA ~1w)

- 支持 6+ vendor adapter (vendor → vendor-specific minimal probe URL + auth header shape)
- dashboard 矩阵 UI (model × server, 色块 + tooltip)
- cron tick 每 24h 自动 probe 所有 enabled provider × model × online daemon → 用户进 dashboard 看到最新矩阵不用手 probe
- audit 页 (admin-only)
- 通信牛 安全终审 round 2

**ship**: v0.14-preview.X

### P3 — 用户自定义 + 模板库 + 历史趋势

- provider 模板库 (一键添加 "Anthropic 主账号 template"，默认 base_url + 模型列表预填)
- 用户自定义 vendor (vendor=`custom` + 用户填 minimal_probe_path)
- 模型历史 (per probe_id 历史曲线，发现 vendor 那段时间宕了)
- key rotation 模式 (写新 key → 用 cron 自动 probe → 全绿后 atomic swap)

**ship**: v0.15-preview.X

---

## 6. 与 RFC-026 的关系

| 维度 | RFC-026 (create-node) | RFC-028 (本) |
|---|---|---|
| 主目的 | dashboard 远程起新节点 | dashboard 集中管 provider + key + 矩阵 |
| Hub-side state | node_create_requests + pendingEnvBlobs Map | providers + provider_models + network_secrets (含密文) + probe_results + pendingProbeSecrets Map |
| Daemon-side new tool | get/ack_create_request + spawn anet node start | get/ack_probe_request + fetch(base_url) |
| Secret 流转 | RFC-026 § 4.4 mint-stream-evict (impl 推后) | **本 RFC 把 mint-stream-evict + AES-GCM at-rest 真落地** |
| 复用骨架 | (源头) | SSE doorbell / ntok 双层 / token-bound daemon resolve (§4.1.4) / orphan revoke sweeper / audit_log |
| 喂下游 | 节点 spec.model 字段 = 用户输入 string | **节点 spec.model 来源 = list_providers + reachability filter** |

→ RFC-028 P1 ship 之后，RFC-026 §4.4 vault 从「P1 stub」升级为「P1 真」(`networkSecretsGet` 接到 network_secrets 表)，RFC-026 P2 env_refs 真用户开始 work。两 RFC 同 release window 互补。

---

## 7. 六个原未决 — 通信龙 v1 review 全锁 (v2 升级)

| # | 决策 | 锁定理由 |
|---|---|---|
| 1 | **master key P1 = env var** (`ANET_HUB_SECRET_VAULT_KEY`) lazy gate | 最少新依赖; v2 F2 改成 lazy (只在首次 vault op 时 require) 避免升级砸生产 (详 §4.1)。**强 doc note (F5)**: master key 轮换 = re-encrypt 所有 secret (P3 工具单独排); env 永不进 log / `process.title` / crash dump / core dump; systemd unit 用 `Environment=` 而非 cmdline 参数 (避免 `ps auxww` 暴露); .env 文件 chmod 600 root:root |
| 2 | **probe 烧 token 防滥点 = rate-limit + 成本标签** | hub-side (provider, model, daemon) 三元组 30s 内最多 1 次 + 每 provider 60req/min 上限 (§4.4.3); dashboard 矩阵 [Probe all] 按钮下显示「每次 ≈ $X」(per vendor adapter 报 minimal cost); cron 每日自动 probe 一次 (P2, dashboard 用户不需手 trigger) |
| 3 | **per-vendor probe adapter** | hub 不假设统一格式; 每 vendor adapter 内硬编码 HTTP method + path + minimal body (§4.4.5); P1 先接 anthropic, P2 扩 openai/zai/openrouter/deepseek/qwen |
| 4 | **vendor-canonical model_name normalize on upsert** | DB 存 vendor 接受的字面形式; anthropic 严格 lowercase + dash, openai 容差大但 normalize 成 "gpt-4o" 等; 减用户搜索 mismatch 困惑 |
| 5 | **in-flight 用旧 key, P1 无版本号** | 新 key 写完一秒生效, in-flight probe/create_node 用旧 key 完成不 fail; P3 上 versioned secret (vendor 切 key 平滑) |
| 6 | **viewer 看 provider 列表 OK, 但永不见 key 值** | operator visibility 高于内网拓扑顾虑; viewer 可见: provider name / vendor / base_url / secret_key_ref (名字) / model 列表 / matrix 状态; **永不见 secret 值** (vault API 不返); 敏感场景 future 加 per-network settings 开关 (P3) 让 admin 选「viewer 不见 base_url」

---

## 8. 不在本 RFC 范围

- key rotation 自动化 / 多 key load-balancing → P3
- 自动 quota 监控 + 报警 → 商业版话题
- multi-region provider failover → 商业版
- 用户自带 LLM (UAA, fine-tune endpoint) → P3
- 与 RFC-020 IM 集成 (channel 用某个 specific provider) → P3 跟 RFC-020 联动

---

## 9. Review checklist — v1 通信龙 first-pass + v2 加项

### v1 通信龙 verdict (PASS 方向)
- [x] §2.2 schema 合理 (provider_models 单独表 — 支持 per-model meta 字段 + reachability join 干净)
- [x] §2.3 工具拆分合理
- [x] §4.1 vault encrypted-at-rest + AES-GCM + master key env — v2 F2 改 lazy gate (本)
- [x] §4.2 role gate (vault owner-only) — 合理
- [x] §4.4 daemon probe 红线 — v2 F1 加 SSRF 三层 (本)
- [x] §5 P1 MVP scope (只 anthropic 起步) — OK
- [x] §6 与 RFC-026 §4.4 vault 接管关系 — 清楚
- [x] §7 6 未决 → v2 全锁

### v2 加项 verdict (通信牛 SEC 复判结果)
- [x] **F2** vault lazy gate — 通过 ✅
- [x] **F3** redact match value (v2) — v3 R3 升级为白名单 ack
- [x] **F4** 三态 model 下拉 — 通过 ✅
- [x] **F5** master key doc — 通过 ✅
- [x] §4.4.5 daemon 硬编码 path — 通过 ✅
- [x] §3.1 cost label — 通过 ✅
- [x] vault lazy / role gate / SEC-1 — 通过 ✅
- [⚠️] **F1** SSRF 三层 — 通信牛 catch 3 真实现坑 → v3 R1/R2/R3 修

### v3 加项 verdict (通信牛 二次复判)
- [x] **R1** redirect manual + 3xx fail — 闭合 ✅
- [x] **R2** undici Agent + customLookup pin + SNI preserved + insecure TLS boot ban — 闭合 ✅
- [⚠️] **R3** daemon ack 白名单 enum — 设计闭合 ✅ 但 doc 自相矛盾 (§2.2 error_message / §2.3 error_message?) → v4 修

### v4 加项 verdict (待终批)
- [ ] **§2.2** `probe_results.error_message` → 重命名 `error_label` + schema-comment HUB-DERIVED ONLY
- [ ] **§2.3** `ack_probe_request` 签名删 `error_message?`, 改 `(probe_id, status, latency_ms, raw_status_code?)`
- [ ] **§4.4.4** 加 `deriveErrorLabel(ack)` hub-side 派生表 (status enum + raw_status_code → 文案)
- [ ] impl 不变量: grep `error_message` 在 daemon + hub code path = 0 命中
- [x] **P1.5 / #310** connector lookup pins the validated A/AAAA set; Node 20
  + Bun split-horizon TLS E2E and pin-removal mutation are load-bearing

---

**作者**: 通信工程马 · 2026-06-29
**Review 路径**: v1 通信龙 first-pass PASS ✅ → v2 折 F1-F5 + §7 lock ✅ → v3 修通信牛 F1 残留 R1/R2 闭 ✅ + R3 设计闭 ✅ → v4 修 R3 doc 一致性 (本) → **通信牛 终批** → Vincent 拍 → 派工 P1 MVP (~3-4d)
