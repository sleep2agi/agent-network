# RFC-012: codex Mobile ↔ anet commhub MCP 桥接

| 项 | 值 |
|----|----|
| **作者** | 通信SDK马 |
| **状态** | Draft v0 (initial — #120 调研驱动, 待 通信龙 + Vincent + 通信牛 review) |
| **关联 issue** | [#120](https://github.com/sleep2agi/agent-network/issues/120) (codex Mobile remote-control 调研) |
| **关联 RFC** | [RFC-006](RFC-006-codex-code-cli-mcp-server.md), [RFC-007](RFC-007-codex-code-cli-mcp.md) (codex runtime 设计) |
| **创建** | 2026-05-15 北京 (UTC+8) |
| **依据** | codex CLI 0.131.0-alpha.8 二进制 + 官方 app-server JSON Schema 245 文件实测 |

---

## 摘要

让 **codex Mobile App 用户能在手机上调度 anet multi-agent 协作**。利用 codex CLI **原生支持的 streamable HTTP MCP server + Bearer auth**（实测: `codex mcp add anet --url <commhub>/mcp --bearer-token-env-var <ENV>` 即注册成功），**零 commhub agent-side 改动 + 零 codex 改动**完成桥接：

```
codex Mobile (用户手机)
   ↓ codex app-server protocol JSON-RPC over WS, method = mcpServer/tool/call
codex 云端 enrollment WS relay (OpenAI 托管)
   ↓
codex CLI on iZrj93pr (remote-control 模式, config.toml mcp_servers.anet = 已注册)
   ↓ standard MCP HTTP POST /mcp, JSON-RPC tools/call
commhub-server /mcp endpoint (现有 17 tools 已 expose)
   ↓ 内部 tasks 表 + pushEvent SSE 单播
anet agent (通信工程马 / N站马 / ...)
```

**核心 insight**: codex app-server protocol 已经原生 `mcpServer/oauth/login` + `mcpServer/tool/call` + `mcpServer/resource/read` + `mcpServerStatus/list` 全套 method，意味着 **codex Mobile 用户能注册任意第三方 MCP server 然后从手机调它的 tools**。commhub 早就是 MCP-compliant，等价于 anet 已经 free-tier 接入 codex Mobile，只差一次本地 `codex mcp add` 命令。

---

## §1 背景

### 1.1 codex Mobile 是什么 (Vincent 2026-05-15 实测情报)

- 手机 App，user 端列出多个 codex 实例 (CLI / Desktop) connection，逐个连
- 各 connection 之间 **互不通信** — codex 没有 agent↔agent 协议
- 解决"user mobility": 用户从手机访问桌面/云端 codex
- 跟 anet 是 **complementary, 非 competitive** — 不同抽象层

### 1.2 anet 想要的杠杆点

让 codex Mobile 用户**通过手机调度 anet multi-agent 协作**:
- 用户场景: 在外面手机上 → 「让 通信工程马 ship preview 然后 N站马 deploy」
- 不需要 user 学 anet 新 client/CLI — 用 codex Mobile 既有 UI
- 不需要 codex 修改 — 利用 codex 已经原生的 MCP server 注册机制

---

## §2 codex MCP server 接入机制 — 实测确认

### 2.1 `codex mcp add` 命令

实测 codex 0.131.0-alpha.8 (alpha tag):

```bash
codex mcp add anet \
  --url https://commhub.example.com/mcp \
  --bearer-token-env-var COMMHUB_TOKEN
```

写入 `~/.codex/config.toml`:
```toml
[mcp_servers.anet]
url = "https://commhub.example.com/mcp"
bearer_token_env_var = "COMMHUB_TOKEN"
```

`codex mcp list` 输出:
```
Name  Url                                Bearer Token Env Var  Status   Auth        
anet  https://commhub.example.com/mcp    COMMHUB_TOKEN         enabled  Bearer token
```

→ **codex CLI 已经原生支持 streamable HTTP MCP server + Bearer auth**，无需任何 anet/commhub 改动。

### 2.2 codex app-server protocol — `mcpServer/*` method 全套

`codex app-server generate-json-schema --out ... --experimental` 导出 245 个 JSON Schema 文件，含:

| Method | 用途 |
|--------|------|
| `mcpServerStatus/list` | mobile 端列出当前所有注册的 MCP server 状态 |
| `mcpServer/oauth/login` | mobile 用户对需要 OAuth 的 MCP server 发起登录流 (commhub MVP 不需要) |
| `mcpServer/tool/call` | mobile 端调一个 MCP tool: `{server, tool, arguments, threadId}` |
| `mcpServer/resource/read` | mobile 端读一个 MCP resource |
| `mcpServerStatus/updated` (notif) | codex CLI 主动 push MCP server 上下线状态变化 |
| `mcpServer/oauthLogin/completed` (notif) | OAuth 流完成事件 |

→ codex 协议层把 MCP 当一等公民对待。**mobile 用户在 codex Mobile UI 里调 anet 工具 = `mcpServer/tool/call({server: "anet", tool: "commhub_send_task", arguments: {alias: "通信工程马", task: "..."}})`**。

### 2.3 路径完整闭环

```
[手机] codex Mobile UI ─→ codex 云端 ─→ codex CLI (remote-control 模式, mcp_servers.anet 已注册)
                                          │
                                          │ codex CLI 看到 mcpServer/tool/call request
                                          │ 转译成 standard MCP HTTP POST
                                          ▼
                            commhub /mcp { tools/call name: "commhub_send_task" }
                                          │
                                          ▼
                            commhub_send_task 内部 → tasks 表 + pushEvent
                                          │
                                          ▼
                            anet agent (SSE listener) 收到 → 执行 → reply
                                          │
                                          ▼
                            结果反向通过 task event → commhub 返回 → codex CLI → 云端 → 手机
```

---

## §3 MVP 设计 (Phase 0)

### 3.1 唯一改动

**只有一个 setup 步骤**: 在每台跑 `agent-node:codex` runtime 的机器上 (用户预期会从 codex Mobile 连接的) 一次性执行:

```bash
# 1. 拿到该用户的 commhub utok_
export COMMHUB_TOKEN="utok_xxxxx"

# 2. 注册 commhub 为 codex MCP server (写 ~/.codex/config.toml)
codex mcp add anet --url $COMMHUB_URL/mcp --bearer-token-env-var COMMHUB_TOKEN

# 3. 启 codex remote-control daemon (供 codex Mobile 连)
codex remote-control --enable remote_control
```

→ codex Mobile 用户对这台机器开 connection 后，能在手机 UI 看到 anet 17 个 tools 并直接调用。

### 3.2 agent-node 集成 (零强制改动, 推荐 add-on)

agent-node:codex runtime 启动时自动做 3.1 步骤 1+2:
- 检测 `~/.codex/config.toml` 是否已有 `mcp_servers.anet`
- 没有则 `codex mcp add` (从 node config.json 拿 COMMHUB_URL + token)
- 用户在外部手动跑 `codex remote-control` 启 mobile-facing daemon

这部分作为 **agent-node 0.2 add-on**，不进 RFC-006/007 主流程。

### 3.3 测试 protocol

1. **Tool listing test**: codex CLI 跑起 + 注册 anet → `codex app-server` instance → 通过 stdio 或 `--listen unix://...` 给 client 发 `mcpServerStatus/list` → 期待 anet 在列且 `Connected`，tools array 含 17 个
2. **Tool call test**: 通过 `mcpServer/tool/call({server:"anet", tool:"get_all_status", arguments:{}})` → 期待返回 commhub 当前 sessions JSON
3. **Mobile end-to-end (需 OpenAI side support)**: codex Mobile App 配置连到本机 codex CLI (config.toml 已注册 anet) → 在 mobile UI 显示 anet tools → 用户点 commhub_send_task → 验证 anet agent 收到任务并执行

---

## §4 Phase 1+ 设计 (未来扩展)

### 4.1 OAuth flow (multi-user friendly)

MVP 用 Bearer-from-env，**单机单 token 假设**。多用户场景 (一台公司机器多个 anet 网络的人都想用 codex Mobile 连):
- commhub-server 加 `/oauth/authorize` (device-code grant) + `/oauth/token` endpoint
- 每个 utok_ 视为 OAuth resource owner
- codex Mobile 用 `mcpServer/oauth/login` 触发流，用户在手机扫码或输代码登 commhub web → web 返回 access token (== utok_) 给 codex CLI
- → 每用户独立 token, 不再依赖共享 ENV_VAR

### 4.2 `thread/goal/*` 协同设计

codex app-server 协议有 `thread/goal/set` / `thread/goal/get` / `thread/goal/clear` (3 个 method) — 跟 anet CLI loop/goal feature 完全重叠。设计协同方向:
- anet agent 完成 task 后，把"持续目标"反映成 codex Mobile UI 看到的 thread goal
- mobile user 在手机上更新 goal → 通过 codex `thread/goal/set` → 反向同步到 anet network 的 task lifecycle
- 待 anet CLI loop/goal feature 设计落地后回看本节

### 4.3 commhub 出现在 codex Mobile project list

让 codex Mobile 项目列表里出现 "anet" 入口:
- 需要在 `app/list` response 中加 anet project (codex 端假定 project = local directory，commhub 需要 fake 一个 virtual project)
- 或 mobile 端 UX 改造: 不通过 project 直接进入 MCP tools 面板

不是 MVP 必要，待 OpenAI/codex Mobile UX 成熟后回看。

---

## §5 与 RFC-006 / RFC-007 关系

| RFC | 关系 | 说明 |
|-----|------|------|
| RFC-006 (codex-code-cli-mcp-server) | **complement** | RFC-006 是 codex-as-anet-runtime (codex CLI 给 anet 网络当 agent runtime); RFC-012 是 codex-as-user-facing-tool 桥接 anet → 不同层不冲突 |
| RFC-007 (codex-code-cli-mcp) | **complement** | 同上, codex CLI 是 MCP server consumer 角度的设计, RFC-012 是把 anet 暴露为 MCP server 的角度 |

**RFC-006/007 加 addendum 推荐**: agent-node:codex 默认开 `features.remote_control = true` + 自动 `codex mcp add anet ...` → 节点天然 mobile-accessible。

---

## §6 与 codex Mobile 的边界

本 RFC **不**:
- 修改 codex CLI / codex Mobile App / codex 云端 (用既有官方 protocol)
- 实现 codex app-server protocol 100 method (我们只是 MCP tool provider)
- 跟 OpenAI 谈 partnership / 走 official integration channel (后期再考虑)

本 RFC **会**:
- 让 commhub 加 OAuth flow (Phase 1 — MVP 不需要)
- 让 agent-node 自动 `codex mcp add` (可选)
- 写 user-facing 文档 「如何用 codex Mobile 操控你的 anet 网络」

---

## §7 实施 Phase

| Phase | 内容 | gate |
|-------|------|------|
| **0** (MVP) | 文档化 setup steps + agent-node:codex 自动 `codex mcp add anet` add-on | codex 0.131.0-alpha.x (remote-control feature) 进 stable |
| **1** | commhub OAuth flow (device-code grant) | Phase 0 真实用户场景验证 (≥1 user 在用) |
| **2** | thread/goal/* 协同 | anet CLI loop/goal feature ship |
| **3** | codex Mobile project list 集成 | OpenAI/codex Mobile 提供 SDK 或公开 partnership channel |

---

## §8 风险

| 风险 | 评估 | 缓解 |
|------|------|------|
| codex Mobile App 不允许第三方 MCP server (private API only) | 中 | Phase 0 测试 (codex CLI side 已确认 OK); Mobile 端不通就走 PWA / 自建 |
| codex remote-control 协议 alpha 阶段变动 | 高 | 关注 codex 0.131.0-alpha.* → stable 演进; 每版本 binary 重跑 generate-json-schema 比对 |
| commhub Bearer token 在 ENV 是单机单租户假设 | 低 (MVP 接受) | Phase 1 OAuth flow 解决 |
| codex Mobile 用户数据流经 OpenAI 云端 | 低 (codex 设计如此, 跟 anet 无关) | 文档明示 — 想本地的话用 Desktop / CLI 不用 Mobile |
| codex feature `remote_control` 仍 under development (features list 实测) | 中 | Phase 0 gate = 该 feature stable 后启动 MVP |

---

## §9 §6 §7 §8 阶段小结

本 RFC 是 **架构性 design-only RFC**，不实施任何代码 (与 RFC-009/010/011 一致)。Vincent + 通信龙 approve 后进 Phase 0 (文档化 + agent-node add-on)，**Phase 1+ 等真实用户场景 trigger**。

---

## 撰写进度

- [x] §1 背景 + Vincent 实测情报
- [x] §2 codex MCP server 机制实测
- [x] §3 MVP 设计 (Phase 0)
- [x] §4 Phase 1+ 扩展 (OAuth / thread/goal/* / project list)
- [x] §5 与 RFC-006/007 关系
- [x] §6 边界声明
- [x] §7 实施 Phase ladder
- [x] §8 风险评估

**Draft v0 完整就绪 — 待 review**:
- 通信龙 high-level
- 通信牛 schema-grounded review (检查我对 codex app-server protocol 的解读是否准确)
- Vincent final

---

## 撰写依据 / 实测 artifact

- **codex CLI binary**: `@openai/codex@0.131.0-alpha.8-linux-x64` (218MB ELF, codex-cli 0.131.0-alpha.8)
- **codex-sdk**: `@openai/codex-sdk@0.131.0-alpha.9` (TypeScript SDK; remote-control **不在**这里)
- **Protocol schema bundle**: 245 个 JSON Schema 文件 (`codex app-server generate-json-schema --experimental`)
- **`codex mcp add` 实测**: `--url` + `--bearer-token-env-var` 写 `[mcp_servers.<name>]` 到 config.toml, `codex mcp list` 显示 enabled status
- **features list 实测**: `remote_control` = under development (即将进 stable)
- **本 RFC 撰写过程**: #120 调研 cron job 46368975 自 Round 1-3 渐进迭代
