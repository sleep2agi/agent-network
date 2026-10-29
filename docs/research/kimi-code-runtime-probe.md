# Kimi Code runtime 调研（无 key 只读探针）

| 项 | 值 |
|---|---|
| 日期 | 2026-10-23 |
| 执行 | 通信欧2号 (n_61cc9eae) |
| 对象 | Kimi Code CLI `2.3.0`（linux-x64 官方二进制，sha256 校验通过） |
| 边界 | **未登录、未用任何 key、未跑真实 turn、未改任何生产配置**；只在 `/tmp/opencode/kimi-probe` 里起了一个本地 server，探针结束已停止并清理 |
| 关联 | RFC-043（`docs/rfcs/RFC-043-kimi-code-runtime.md`） |

---

## 0. 结论（先看这五条）

1. **npm 上的 `kimi-code` 不是官方 CLI**，是一个第三方 Groq/Kimi proxy 小包（4 个文件、依赖 keytar/fastify）。真东西是 GitHub Releases 里的**单文件二进制**（184 MB，带 `.sha256`）。RFC 里「npm 包 `kimi-code@1.0.11`」这句要改。
2. **共享 server 可行**：一个 `kimi web` 承载多个 session；模型的、权限的、MCP 的选择都是 **per-session**（`agent_config.model / permission_mode / mcp_servers / thinking / plan_mode`），建会话可设，`POST /sessions/{id}/profile` 可改。
3. **「每节点 MCP 身份被摊平」这个担忧不成立**：MCP server 走 `/api/v2/mcp/servers` 注册，http/sse 型支持 **`headers`** 和 **`bearerTokenEnvVar`** —— 一个 home 里放 N 个条目（每节点一个 token），session 按名选自己的那个。
4. **共存形态确定了**：Kimi 有**跨进程 session 排他锁**（`<home>/locks/sessions/<sid>`，记 pid/hostname/startedAt，持有者进程死了会被自动接管）。而且 **TUI 是独立引擎**（`harness.resumeSession`，不走 server），所以 TUI 与 daemon 只能是**交接（handoff）**；**Web UI 与 REST/WS 同进程**，那才是**真·同时共享**。
5. **无登录也能起 server、建 session、拿 openapi/asyncapi** —— 意味着契约测试可以完全离线跑，不必把真 key 放进 CI。

---

## 1. 方法与基线

```bash
# 1) 官方二进制（GitHub Releases，不依赖被墙的 install.sh 域名）
gh release download "@moonshot-ai/kimi-code@2.3.0" --repo MoonshotAI/kimi-code \
  --pattern "kimi-code-linux-x64.tar.gz*" --dir .
sha256sum kimi-code-linux-x64.tar.gz   # 与 .sha256 一致

# 2) 隔离 home 起 server（无登录）
KIMI_CODE_HOME=/tmp/.../home ./bin/kimi web --no-open --port 58699

# 3) 取 token（banner 与控制台都会打印；落盘在 $KIMI_CODE_HOME/server.token, 0600）
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:58699/openapi.json
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:58699/asyncapi.json
```

实测读数：`GET /api/v1/healthz` → 200；`POST /api/v1/sessions` → 200 且返回 `session_...`（**未登录就成功**，因为 session 只是服务端对象，真正跑 turn 才需要 provider）。

> 顺带一个坑：`https://code.kimi.com/kimi-code/install.sh` 在本机**连不上**（120s 超时）。官方安装脚本可用性依赖网络，产品化时应走 GitHub Releases + sha256，而不是 `curl | bash`。

---

## 2. 能力实测表

| 问题 | 结论 | 证据 |
|---|---|---|
| 一台机器能否一个 server 扛多节点 | **可以** | session 是服务端对象；`GET /api/v2/sessions` 分页枚举；每 session 独立 `cwd`/`metadata` |
| 模型能否按节点不同 | **可以** | `agent_config.model` 建会话可设，`POST /sessions/{id}/profile` 可改 |
| 权限模式能否按节点不同 | **可以** | `agent_config.permission_mode ∈ {manual, yolo, auto}` |
| MCP 能否按节点不同 | **可以，且凭据可不同** | `agent_config.mcp_servers: string[]`（选名字）+ `/api/v2/mcp/servers` 的 http/sse 变体带 `headers`、`bearerTokenEnvVar` |
| 系统提示能否按节点不同 | 可以 | `agent_config.system_prompt` |
| 工具白名单 | 可以 | `agent_config.tools: string[]` |
| 多客户端同 session | **排他锁**（跨进程） | `packages/agent-core-v2/src/persistence/backends/node-fs/sessionLockService.ts`：`linkSync` 原子建锁、`pidAlive` 判活、死主 reclaim |
| 锁什么时候拿 | **run 开始时**（不是 session 打开就锁死） | `sessionRunGateService.begin()` → `sessionLocks.hold(sessionId)`，`toDisposable` 释放 |
| 被外部改过怎么办 | `40932 SESSION_STALE` → 必须 reload | 同上 `externallyModified()` 分支 |
| 能不能强行接管别人的锁 | 有 `:takeover` action | `packages/kap-server/src/routes/sessions.ts` `takeoverSessionAction` |
| TUI 是连 server 还是自起引擎 | **自起引擎** | `apps/kimi-code/src/tui/kimi-tui.ts` 走 `harness.resumeSession(...)`；源码里没有把 TUI 指向 `kimi web` 的通道 |
| Web UI 与 API 是否同进程 | **同进程** | `kimi web` = 一个进程同时服务 REST/WS 与 web 静态资源（官方文档 + 启动 banner） |
| 事件流形态 | `subscribe_v2` 订阅 + `session_event`（带 `seq`/`epoch`/`volatile`） | `/asyncapi.json`；`VOLATILE_EVENT_TYPES` 含 `assistant.delta`/`tool.progress` 等 |
| 断线恢复 | `resync_required` 信号 + `snapshot`/`transcript` 重建 | asyncapi `resync_required`；openapi `/sessions/{id}/snapshot` |
| 鉴权 | Bearer，`server.token` 按 home；`--dangerous-bypass-auth` 可关掉（禁止使用） | 启动 banner + `/api/v1/meta.dangerous_bypass_auth` |

### 2.1 事件是「volatile + 需 resync」的
`assistant.delta` 这类增量被明确标为 **volatile（不重放）**。所以我们适配器不能假设「断线重连就能补齐」：必须用 `session_event.seq` 判断缺口，缺了就用 `snapshot` / `transcript` 重建，否则 Hub 侧会出现「回复只有后半段」。

---

## 3. 对 RFC-043 的三处修订

### 3.1 §2.2 安装方式（**必改**）

- 原文：npm 上有 `kimi-code@1.0.11`。
- 实际：那是个第三方 Groq proxy，**不是** Moonshot 官方 CLI。
- 正确：GitHub Releases 的 `kimi-code-<platform>.tar.gz` + `.sha256`，安装走「下载 + 校验 + 落盘固定路径」，版本 pin 到具体 tag。

### 3.2 §7.3「TUI 是连 server 还是自起引擎」→ **已答：自起引擎**

| 形态 | 共享引擎？ | 共存语义 |
|---|---|---|
| Web UI（`kimi web` 自带） | ✅ 同进程 | **真·同时共享**：人和 Agent 是同一引擎的两个客户端 |
| TUI（`kimi --session <S>`） | ❌ 独立引擎 | **排他交接**：谁持有 session 锁谁写；另一方 `40931`，等交接 |

所以：
- 要「人在旁边实时看着 Agent 干」→ **浏览器前台**最自然（成本在 Hub 侧反代 +3–5 天）；
- 要「人接手干、Agent 让位」→ **TUI 前台**，代价是人退出后 Agent 才继续（这正是我们 #2014 的「前台/后台」语义）。

**建议**：v1 先把 TUI 交接做扎实（复用现有 tmux + #2014 语义），浏览器前台作为 v2 增量。若 admin 要的是「同时看见」，那浏览器就是唯一正确解，需要把反代排进来。

### 3.3 §12.3「per-session MCP」→ **已答：支持**

`agent_config.mcp_servers` 是字符串数组（选注册表里的名字），注册走 `/api/v2/mcp/servers`，http/sse 条目支持 `headers` 与 `bearerTokenEnvVar`。因此共享 server 下**每节点可以用自己的 token**，身份不摊平。

唯一残留：`bearerTokenEnvVar` 读的是 **server 进程的环境变量**（不是 session 的），所以 N 个节点要 N 个 env var（`KIMI_MCP_TOKEN_NODE_A` …），在 server 启动时注入。这要求 **server 由 daemon 启动**（不能复用别人随手起的），否则拿不到这些 env。

---

## 4. 仍未验证（需要 key，属于 M0 剩余部分）

1. 真实 turn 的流式形状（`assistant.delta` 粒度、thinking 是否单独事件）；
2. 审批往返：`pending_interaction` → `GET /sessions/{id}/approvals` → `POST .../approvals/{id}` 的实际时延与字段；
3. 模型切换后的**回读**（`GET /sessions/{id}/status` 里的 `thinking_level` 已能看到，但 model 是否也回读需确认）；
4. `40931` 在真实 turn 中的表现（本次用伪造锁文件+无 provider 没触发，因为错误在异步 run 里被 provider 错误盖住）；
5. `session/resume` 与 `snapshot` 在长会话上的恢复耗时。

---

## 5. 复现清单（任何人可重跑）

```bash
# 二进制
gh release download "@moonshot-ai/kimi-code@2.3.0" -R MoonshotAI/kimi-code -p "kimi-code-linux-x64.tar.gz*" -D .
tar -xzf kimi-code-linux-x64.tar.gz && ./kimi --version    # 2.3.0

# server（无登录）
KIMI_CODE_HOME=$PWD/home ./kimi web --no-open --port 58699 &
TOKEN=$(cat home/server.token)
curl -s -H "Authorization: Bearer $TOKEN" localhost:58699/api/v1/healthz
curl -s -H "Authorization: Bearer $TOKEN" -XPOST localhost:58699/api/v1/sessions \
  -H 'Content-Type: application/json' -d '{"metadata":{"cwd":"'$PWD'/ws"}}'

# 结构体（离线契约测试的原料）
curl -s -H "Authorization: Bearer $TOKEN" localhost:58699/openapi.json  -o openapi.json
curl -s -H "Authorization: Bearer $TOKEN" localhost:58699/asyncapi.json -o asyncapi.json
```

> 本报告的每条结论都可以用上面的命令 + 源码位置复核；没有一条依赖「听说」。
