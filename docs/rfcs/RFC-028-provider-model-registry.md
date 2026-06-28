# RFC-028 — Provider & Model Registry + 连通性矩阵

**作者**: 通信工程马
**状态**: Draft v1（design-first，待 通信龙 review → 通信牛 安全审 → Vincent 拍）
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
  status          TEXT NOT NULL,           -- pending/ok/timeout/auth_fail/quota/network_error/other
  latency_ms      INTEGER,
  error_message   TEXT,                    -- 截断到 500 字, 不含 secret
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
8. `ack_probe_request(probe_id, status, latency_ms, error_message?, raw_status_code?)`

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
│  ┌───────────────────────────────────────────────────────┐      │
│  │              server-A     server-B     local-laptop    │      │
│  │ claude-opus  ✓ 180ms     ✓ 220ms      ✗ network_err   │      │
│  │ claude-sonn  ✓ 150ms     ✗ 401        ✓ 190ms          │      │
│  │ gpt-4o       ✗ unset     ✗ unset      ✓ 250ms          │      │
│  └───────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Provider CRUD 流程

- **Add Provider**: form (name / vendor enum / base_url / key) — key 字段是 vault picker（不接受裸值写入；如要新加 key 走单独的 vault 管理子页）
- **Add Model**: form (model_name / display_name / context_window / supports_vision)
- **Test connectivity**: 点 [test all servers] 按钮 → 对该 network 在线的每个 daemon 派一发 probe → 3-10s 矩阵更新

### 3.3 喂给 create-node #299 的 model 下拉

`create_node` 工具的 `model` 字段原本接 user-typed string。本 RFC 后：

- dashboard create-node wizard step 2 「Runtime + Model」：runtime 不变，model 改成下拉
- 下拉源 = `list_providers()` → 展开成 `(vendor, model_name)` 列表，按目标 daemon 的 reachability_matrix 过滤（仅显示该 daemon 上 probe=`ok` 的 model；degraded `auth_fail/network_err` 标红降级仍可选但带 ⚠️）
- 用户选了后 `node_spec.model` 还是 string；dashboard 也额外传 `provider_id` → hub 在 create_node 内部把 vault key 关联进 env_refs（复用 RFC-026 §4.4.7 流程）

---

## 4. 安全边界

**provider key 是高价值目标**——一个 key 漏 = 整个 fleet 烧账单。安全规则比 create-node 更紧。

### 4.1 vault 落地（RFC-026 §4.4 接管）

- **encrypted-at-rest**: `network_secrets` 表 BLOB 列存 AES-GCM 密文，master key from `ANET_HUB_SECRET_VAULT_KEY` env var（hub 启动 require，缺 → exit），key 32 bytes hex
- **plaintext lifetime**: 解密只发生在 (a) vault 写入时 enc/读出时 dec，(b) probe/create-node 派单瞬间 mint-stream-evict
- **DB 备份/快照里只有密文**: master key 不在 DB
- **`secret_key` 字段 dashboard 永远写「key 名」不写「key 值」**：UI 永不直接接受 textfield；强制走单独「Secret Vault」管理子页才能写 key 值
- **key 列出去时只回 key 名 + 是否在 vault**：list_providers 返 `{ secret_key_ref: "ANTHROPIC_API_KEY", in_vault: true }`，永不返值

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

### 4.4 daemon 侧 (probe 工具的特殊红线)

- **probe 请求 size 上限**: 1KB request body 上限；防 daemon 被劫持去 send massive payload
- **base_url 必须 https** (开发 hub 允许 http to localhost only, 其它一律 reject)
- **timeout 强制 < 30s**: probe 不能用来攻击远端 (long-poll 等)
- **rate limit per provider**: hub-side 每 provider 60 req/min 上限 (反向防 DoS 给 vendor)
- **error_message 写表前必 redact secret**: hub-side 跑 `redactSecrets(text, knownKeysFromVault)` 防 vendor 错误信息回显了 key (Anthropic 返 `Invalid API key: sk-...` 实例)
- **probe 不能任意 URL**: daemon 只接受 `vendor` enum + `provider.base_url` 组合，不接受 hub 派进来的任意 host (B2 同 ANET_BIN_ABS 思路, daemon 不信 hub 派的任意 endpoint)

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

## 7. 未决问题（待 review 拍）

1. **master key 落地姿势**: env var (`ANET_HUB_SECRET_VAULT_KEY`) vs systemd-creds vs hashicorp vault 集成？P1 倾向 env var (最少新依赖)，P2 可选 systemd-creds (Linux distros prod)，P3 看用户量再上 vault adapter
2. **每次 probe 都真打 vendor API = 真烧 token**: 1 次 anthropic /v1/messages minimal tokens ≈ $0.0001。需要 dashboard 上明确「按 1 次会扣 X token」否则 admin 滥点会被 vendor 反映扣费。倾向: cron probe 一天 1 次 + dashboard 手动 probe button 30s rate limit per (provider, model, daemon) 三元组 (防滥点)
3. **vendor 不支持 minimal probe**: 比如某 vendor 只有 chat completion endpoint, minimal probe 要发 "hi" 一条消息 + 至少 1 token output。倾向: per-vendor adapter 决定 probe shape, hub 不假设统一格式
4. **model_name 大小写敏感**: anthropic 接受 "claude-opus-4-6" 严格, openai 接受 "gpt-4o" vs "GPT-4o" 等价。倾向: DB 存 vendor-canonical 形式 (vendor adapter normalize on upsert)
5. **key rotation 时 in-flight probe / create-node 的 secret 哪份**: P1 简化「新 key 写完一秒生效，in-flight 用旧 key 完成」(无版本号)；P3 真上 versioned secret (vendor 切 key 平滑)
6. **dashboard show provider 列表给 viewer**: viewer 是否看得见 base_url + key 名 (不是 key 值) ? 倾向 yes (operator visibility), 但若敏感场景 (内网拓扑) 可加 settings 开关 admin-only

---

## 8. 不在本 RFC 范围

- key rotation 自动化 / 多 key load-balancing → P3
- 自动 quota 监控 + 报警 → 商业版话题
- multi-region provider failover → 商业版
- 用户自带 LLM (UAA, fine-tune endpoint) → P3
- 与 RFC-020 IM 集成 (channel 用某个 specific provider) → P3 跟 RFC-020 联动

---

## 9. Review checklist (给 reviewer)

- [ ] §2.2 schema 是否合理 (provider_models 单独表 vs JSON 列?)
- [ ] §2.3 7 工具拆分是否合理 (probe 是 1 个 hub tool + 2 daemon tools 是否够)
- [ ] §4.1 vault encrypted-at-rest + AES-GCM + master key env var 选型
- [ ] §4.2 role gate (vault upsert owner-only 是否太严?)
- [ ] §4.4 daemon probe 红线 (size limit / timeout / rate limit / redact / no任意 URL) 是否够
- [ ] §5 P1 MVP scope (只 anthropic vendor 起步是否合适)
- [ ] §6 与 RFC-026 §4.4 vault 接管关系是否清楚
- [ ] §7 未决 6 点 reviewer 各拍 1 个 verdict

---

**作者**: 通信工程马 · 2026-06-29
**Review 路径**: 通信龙 first-pass → 通信牛 安全审 (碰 key vault 强制) → Vincent 拍 → 派工 P1
