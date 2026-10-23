# RFC-043: Kimi Code runtime 接入方案

| 项 | 值 |
|----|----|
| **作者** | 通信欧2号 (n_61cc9eae) |
| **状态** | v0.1 draft — 只出方案与工时校准，未动代码、未改任何生产配置 |
| **创建** | 2026-10-23 |
| **关联** | [RFC-029](RFC-029-opencode-runtime-integration.md)（opencode runtime，同为「app-server + 事件流」形状）· `agent-node/src/runtime/codex-app-server/`（最接近的参照实现） |
| **目标读者** | admin / 需求池评审 / 落地实现者 |

---

## 摘要

给 anet 加**第 8 种 runtime**：Moonshot 的 **Kimi Code CLI**（`kimi`，2026 年发布，TypeScript + 单文件二进制，npm 包 `kimi-code@1.0.11`）。

**推荐路线 A：把它当 `codex-app-server` 同款「本地 app-server」接** —— Kimi 自带 `kimi web`，暴露 REST `/api/v1/*` + WebSocket `/api/v1/ws`，会话、流式增量、工具调用、审批、切模型、会话恢复都是现成的，与我们已有的 `codex-app-server` 形状一致，**不需要做 PTY/tmux 驱动**。

**工时：14–19 人日（含缓冲 17–21）**，其中 **M0 摸底 2 天就能给出「能不能做、真实工时多少」的硬结论**，M1 结束（约第 7 天）能看到一个真实节点回消息。

**额外红利**：Kimi 的会话是**服务端共享**的，人用 TUI/web 和 Agent 走 API 是**同一个 session**，所以「人机共存」几乎白送 —— 而 Codex 那条线为此写了 3200 行 copresence 驱动。

---

## 1. 目标与非目标

### 目标（v1 验收）

1. `anet init node`（或客户端建节点）可选 `kimi-code` runtime，节点能起、能连 Hub、能收任务、能回消息；
2. 流式输出、工具调用可见、可取消；
3. 节点重启后能 `resume` 原会话继续，不丢上下文；
4. 模型可按节点固定并支持切换（Kimi 的 model alias 机制）；
5. 权限与现有语义对齐：`dangerouslySkipPermissions` ≈ Kimi `yolo`，否则审批可回到 Hub；
6. 能注入 Hub 的 MCP server（复用 `send_task` / `send_message` 等能力）；
7. 与 `agent-network` / `agent-node` 版本配对，进正常发版流程。

### 非目标（v1 不做）

- 不做 Kimi 的 `AgentSwarm` / `secondary_model` 子智能体编排（只当普通工具调用结果看）；
- 不做 Kimi Desktop / Remote Control / web 前端代理；
- 不替换现有 7 个 runtime，不改它们的默认值；
- 不做 Windows 首发的兼容承诺（见 §10 风险）。

---

## 2. 关键外部事实（依据：官方文档 + 仓库实测，2026-10-23）

### 2.1 Kimi Code 提供的程序化入口（两条，都有官方文档）

| 入口 | 形态 | 关键能力 |
|---|---|---|
| **`kimi web`**（推荐） | 本地 HTTP server，默认 `127.0.0.1:58627`，Bearer token；REST `/api/v1` + WS `/api/v1/ws` | 建/列/恢复/分叉/中止会话；prompt 提交；事件流 `turn.started` → `assistant.delta` → `tool.call.started` / `tool.result` → `turn.ended`；审批（`pending_interaction: none/approval/question`）；切模型；`GET /openapi.json` + `/asyncapi.json` 自描述 |
| `kimi acp` | ACP over stdio（JSON-RPC），Zed/JetBrains 用 | `session/new·load·resume·fork·list·close·delete`、`session/prompt`、`session/cancel`、`set_mode`、`set_config_option`、扩展 `set_model`、MCP 转发（http/sse/stdio）、`request_permission` |
| `kimi -p "..."` | 一次性打印模式 | 只做一次性任务，无会话连续性（本方案的**兜底**，不是主线） |

> ⚠️ `kimi web` 的 REST/WS 被官方明确标注为 **experimental：接口稳定性不保证**，字段/事件可能在任何版本变。这是本方案最大的工程风险，对策见 §10。

### 2.2 配置与鉴权（决定「能不能无人值守」）

- 数据目录可整体重定向：`KIMI_CODE_HOME` → 配置落在 `$KIMI_CODE_HOME/config.toml`（TOML）。**这一条让我们可以沿用 `grok-build-cli-home` 的每节点独立 home 做法。**
- Provider 凭据支持三种写法，其中 **`api_key_env = "VAR_NAME"`（每次请求重读环境变量，不落盘）** —— 这是无人值守节点的正确姿势，不需要人点浏览器的 OAuth 设备码。
- 官方明确：**不会**自动读取 shell 的 `KIMI_API_KEY`，必须显式写在 `config.toml` 里或指向 `api_key_env`。
- 权限模式一档到位：`default_permission_mode = "manual" | "auto" | "yolo"`，另有 `[[permission.rules]]` 细粒度规则和 `dangerous_command_guard` 总闸。
- MCP 声明在 `~/.kimi-code/mcp.json`（或项目内 `.kimi-code/mcp.json`），支持 http/stdio/sse。
- 安装：官方 `install.sh` / `install.ps1`（单文件二进制，不依赖 Node）；npm 上也有 `kimi-code@1.0.11`。Windows 需要 Git Bash，`KIMI_SHELL_PATH` 可覆盖。

### 2.3 与我们现有代码的同构度（决定工时）

| 能力 | 现有参照 | 参照实现体量（含测试） |
|---|---|---|
| 常驻 server + 事件流 | `agent-node/src/runtime/codex-app-server/` | ≈ 4.7k 行 |
| ACP stdio 客户端（可复用） | `agent-node/src/runtime/opencode-acp/`、`grok-build-acp/` | 5.9k / 1.8k 行 |
| 每节点独立 home | `grok-build-cli-home.ts` | — |
| runtime 注册落点 | 全仓 grep 一个 runtime 名 | **19 个文件，多数 1–6 行命中** |

当前 7 个 runtime：`claude-code-cli` / `codex-sdk` / `claude-agent-sdk` / `grok-build-acp` / `grok-build-cli` / `opencode-cli` / `codex-app-server`。

---

## 3. 路线对比

| | **A. `kimi web` app-server（推荐）** | B. ACP stdio | C. 打印模式 |
|---|---|---|---|
| 复用底座 | codex-app-server 形状 | 现成 ACP 客户端 | 无 |
| 会话管理 | ✅ 服务端持久化 + list/resume/fork | ✅ load/resume | ❌ 一次性 |
| 事件/流式 | ✅ WS，字段齐全 | ✅ `session/update` | 仅 stdout |
| 审批 | ✅ 服务端 `pending_interaction` + yolo 关掉 | ✅ `request_permission` | ❌ |
| 切模型 | ✅ `set_config_option` / `set_model` | ✅ | 命令行参数 |
| 人机共存 | ✅ **同一 session 天然共享** | ⚠️ 取决于能否挂 TUI | ❌ |
| 稳定性 | ⚠️ 官方标 experimental | ✅ ACP 是稳定协议 | ✅ |
| 工时 | **14–19 人日** | 11–14 人日 | 1–2 人日 |
| 判断 | **主线** | 备选（若 A 的接口震荡到不可控） | 只做演示/应急，不进产品 |

**结论：主线走 A。** 理由：我们要的不只是「能回消息」，而是**会话生命周期 + 审批 + 切模型 + 共存**这四件，A 一次全给；B 省 3–5 天但换来的是一个更薄的契约（ACP 只覆盖「驱动一个会话」，没有服务端会话库、没有 `pending_interaction` 聚合，审批还要自己在客户端侧桥）。C 只用于 M0 之前给人「看到东西」。

---

## 4. 推荐架构（路线 A）

```
CommHub Hub
   │  (既有 WS/HTTP 协议，不变)
   ▼
agent-node daemon ── runtime=kimi-code ──┐
   │                                    │
   │  ① spawn: kimi web --port <p>      │  ② REST /api/v1/sessions/:id/prompts
   │     env: KIMI_CODE_HOME=<node-home>│     REST /api/v1/sessions/:id:{abort,fork,compact}
   │          KIMI_API_KEY=<from secret>│  ③ WS /api/v1/ws (subscribe session_ids)
   ▼                                    ▼
kimi web (per-node 隔离实例)  ←── 人类 TUI / 浏览器 (同一 session，共存)
```

### 4.1 模块清单（新增）

| 文件 | 职责 | 预估行数（含注释） |
|---|---|---|
| `agent-node/src/runtime/kimi-code/client.ts` | REST 封装：会话 CRUD、prompt、abort、approvals、models、config | 300–400 |
| `agent-node/src/runtime/kimi-code/events.ts` | WS 事件 → 内部消息模型（文本增量、工具调用、turn 边界、错误） | 200–300 |
| `agent-node/src/runtime/kimi-code/lifecycle.ts` | 起停 `kimi web`、端口分配、健康检查（`/api/v1/healthz`）、退出回收、实例注册表避让 | 250–350 |
| `agent-node/src/runtime/kimi-code/home.ts` | 生成 `config.toml`（provider/models/permission/telemetry 关）/ 每 alias 独立 `KIMI_CODE_HOME` | 250–350 |
| `agent-node/src/runtime/kimi-code/runtime.ts` | 实现 daemon 需要的 runtime 接口（think/stream/cancel/resume/model） | 300–400 |
| `agent-node/src/runtime/kimi-code/*.test.ts` | 单测（**离线夹具**，不依赖真实 key） | 600–900 |
| `agent-network/src/kimi-code-pair.ts` | 版本配对（沿用 `opencode-agent-node-pair` 形态） | 40 |

### 4.2 注册落点清单（改，不加新文件）

按现有 runtime 名的命中面（19 个文件），逐个确认：

1. `agent-node/src/cli.ts` — runtime 白名单 + 参数解析 + 默认值
2. `agent-network/src/normalize-runtime.ts` — `RuntimeName` 联合类型 + 严格校验
3. `agent-network/src/normalize-runtime.test.ts`
4. `agent-node/src/goals/store.ts` (+test) — 受支持的 runtime 列表
5. `agent-network/src/package-mode-preflight.ts` (+test) — 包模式预检
6. `agent-network/src/unsafe-package-path-reason.ts` — 危险路径判定
7. `agent-node/src/runtime-effective-label.ts` (+test) — 展示名
8. `agent-network/src/tmux-pane-prompt.test.ts` — 共存分支（若走共存）
9. `agent-network/src/*copresence-profile*` — 共存 profile（M4）
10. 客户端 `agent-network-app`：runtime 徽标/文案（走既有 i18n）
11. 文档：`docs/`（README runtime 表、RELEASE-SOP 配对说明）

---

## 5. 里程碑与工时

| 里程碑 | 交付 | 人日 | 完成判据（可验证） |
|---|---|---|---|
| **M0 摸底探针** | 本机装 `kimi-code`，`KIMI_CODE_HOME` 隔离，`kimi web` 起，用一个**脚本**手工走完：建会话 → 发 prompt → 收 WS 事件 → 触发审批 → 批准 → 取消 → resume → 切模型 → 注入 MCP | **2** | 一份 probe 日志 + 事件字段实物样例 + 校准后的工时 |
| **M1 headless 骨架** | client + events + lifecycle + runtime；单节点端到端 | 5–7 | 一个真实 Kimi 节点在 Hub 回 `PING-OK`，能看到流式与工具调用 |
| **M2 鉴权/权限/模型** | home 生成器、`api_key_env` 注入、`yolo`/`manual` 映射、model alias 与切换、重启 resume | 2–3 | 节点重启后接着原会话；`set_model` 生效且可回读 |
| **M3 注册 + 入口** | §4.2 全部落点 + 客户端建节点选项 + 版本配对 | 2 | `anet init node --runtime kimi-code` 一次通过；客户端可选 |
| **M4 共存 + 硬化** | 人机同 session、`40931/40932` 冲突处理、契约测试、real-client 门禁、发版 | 3–5 | 人与 Agent 同时驱动同一会话不互相破坏；发布到 preview |

**合计 14–19 人日**（不含缓冲）；按历史经验留 20% 缓冲 → **17–21 人日**。
两人并行时，M0 与 M3 的文档/注册部分可提前并行，约 **2 周**。

**如果只想要「今天看到东西」**：M0 里抽出路线 C（`kimi -p`）做 1–2 天的演示节点，不进产品 —— 但**我建议不做**，因为它的价值只是截图，不是能力。

---

## 6. 鉴权与权限模型（本方案的关键决策）

### 6.1 鉴权（决定能否无人值守）

```
节点启动
  └─ 生成 $KIMI_CODE_HOME/config.toml
        [providers."kimi"]
        type = "kimi"
        base_url = "<可配，默认 api.kimi.com/coding/v1>"
        api_key_env = "KIMI_API_KEY"        # 不落盘
        [models."kimi-for-coding"] ...
        default_model = "kimi-for-coding"
  └─ 进程中注入 KIMI_API_KEY（来源：节点密钥库 / 环境变量，沿用现有 secret 注入路径）
```

- **不用** OAuth 设备码：那需要人点浏览器，不适合节点。
- 若组织只提供「Kimi 会员登录态」而非开放平台 key，则存在 **M2 的额外分支**（把已登录的 `oauth` 段拷进每节点 home），工时 +1–2 天，且与客服条款相关 —— 列为待决问题 Q1。

### 6.2 权限

| anet 语义 | Kimi 配置 | 备注 |
|---|---|---|
| `dangerouslySkipPermissions: true` | `default_permission_mode = "yolo"` + `dangerous_command_guard = false` | 与现有 yolo runtime 一致 |
| 默认（需审批） | `manual`，审批经 `pending_interaction` → Hub 卡片 | v1 可先只支持「yolo / 拒绝执行」两档，审批回流放 M4 |
| 工具黑名单 | `[[permission.rules]] decision="deny"` | 可选 |

---

## 7. 共存（copresence）为什么几乎白送

Kimi 的 session 是**服务端对象**：`POST /api/v1/sessions` 建出来的 id，人类用 `kimi` TUI 或 `kimi web` 打开、Agent 用 REST 打，**是同一个 session**（官方对多客户端并发有明确语义：`40931` 另一进程正在写、`40932` 已被别的客户端更新）。

对比 Codex 那条线（`grok-copresence/runtime.ts` 3200 行 + `grok-copresence` 全套 tmux 驱动），Kimi 这边要做的是**冲突处理**而不是**会话搬运**，量级差一个数量级。

**因此 §9 的「共存」在路线 A 里是 M4 的 3–5 天里的一部分，不是额外的一个月。**

---

## 8. 验收标准（端到端断言清单）

M4 合并前必须逐条有证据（日志/截图/测试名）：

1. 建节点 → 收任务 → 回 `PING-OK`，Hub 侧可见；
2. 流式：一个长回答期间 Hub 能看到增量（不是最后一次性吐）；
3. 工具调用：`tool.call.started` / `tool.result` 在 Hub 可见（含命令与退出码）；
4. 取消：Hub 侧 cancel → Kimi `:abort` → turn 结束且**不重放**；
5. 恢复：kill 节点 → 重启 → 继续原 session，上下文不丢；
6. 模型：切 alias 生效，且能从 Kimi 回读确认（不是我们自说自话）；
7. 权限：yolo 下不卡审批；manual 下卡住并能从 Hub 批准/拒绝；
8. MCP：节点能调 Hub 的 MCP 工具（如 `send_message`）并成功；
9. 错误分类：401（key 失效）/ 40110（无 provider）/ `40931`（并发占用）/ 超时 / 429 各自落到正确文案与是否重试的判定；
10. 升级：其它 6 个 runtime 的既有测试全绿（不得回归）。

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `kimi web` 接口官方标 experimental | 升级即破 | **锁版本**（pin 到具体版本，禁 `latest`）+ 契约测试（拿 `/openapi.json` 比对关键字段）+ 升级走 preview 通道 |
| 只有会员登录、没有开放平台 key | 无法无人值守 | Q1 待决；退路是「拷 oauth 段进每节点 home」（+1–2 天，合规待确认） |
| Windows 需 Git Bash | Windows 节点不可用 | v1 声明不支持；`KIMI_SHELL_PATH` 方案留 M5 |
| real-client 需要真实 key 进 CI | 门禁建不起来 | 先做「离线夹具 + 手动 real-client 记录」，secrets 走治理流程（Q2） |
| 额度/限流（429） | 长任务被截断 | 复用现有错误分类与退避；不自动重试「配额耗尽」类 429（官方语义同 Codex） |
| 多客户端并发（人 + Agent） | 互相踩写 | 只用 `40931/40932` 官方语义处理：等空闲再重试，不强制覆盖 |
| 二进制分发的供应链 | 安装来源不可控 | 优先 npm `kimi-code`（可校验完整性），官方脚本作为备选；不用 `curl \| bash` 进产品路径 |

---

## 10. 待决问题（需要 admin / 产品拍板）

1. **Q1 鉴权**：我们有没有 Kimi **开放平台 API key**（按 token 计费）？还是只能用会员登录态？这条直接决定 M2 是 2 天还是 4 天。
2. **Q2 CI**：允许把 Kimi key 放进 CI secrets 做 real-client 门禁吗？不允许的话，验收退化为「人工记录 + 离线夹具」。
3. **Q3 定位**：Kimi 是「第 8 个一等 runtime」（进建节点向导、进文档、进版本配对），还是先隐藏 flag 试水两周？
4. **Q4 共存**：v1 就要人机同 session，还是先 headless、共存放 M5？
5. **Q5 优先级**：这条和当前 in-flight 的 OpenCode V2 / 0.2.29x 客户端 / Hub 发版积压相比，排第几？我建议**不打断现有线**，用「M0 两天探针」先占位。

---

## 11. 我建议的执行顺序

1. **本周**：M0 两天探针（只要一个 key），产出实测结论 → 把本 RFC 的工时从「文档估算」升级成「实测估算」；
2. 探针通过 → M1 起骨架（此时才动代码，且只新增文件，不碰现有 runtime）；
3. 期间不阻塞任何在飞的 OpenCode V2 / 客户端工作。

> 本 RFC 只写方案：**未安装任何东西、未创建节点、未改生产配置、未动其它分支。**
