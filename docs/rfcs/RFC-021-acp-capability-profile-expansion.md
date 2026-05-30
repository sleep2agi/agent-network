# RFC-021: ACP Capability Profile Expansion — 让 grok-build-acp 隔离节点用上 X 搜索 / 视频生成

> **Status**: Draft (Phase 1, v1)
> **Author**: 通信SDK马
> **Related issue**: [#205](https://github.com/sleep2agi/agent-network/issues/205) / [#206](https://github.com/sleep2agi/agent-network/issues/206)
> **Date**: 2026-05-28
> **Review gate**: 通信牛 二审 → Phase 2 实施

## 1. 背景 + 问题

### 1.1 触发 ([A站负责人 task 785b464e])

A站负责人 用 `grok-build-acp` runtime 节点跑机智流 AI 日报 brief(24h 关键词 + 头部账号搜索),`search_tool` 0 hit。**ACP-隔离的 Grok runtime 拿不到 backend tools** (X 搜索 / video_gen / web_search) 给 LLM 用。

### 1.2 跟 #205 Step 1 capability probe 的关系(诚实 surface)

我在 [grok-x-search-capability-probe.md] 写过 "anet 接入零代码" — 是基于 Vincent **现有非 ACP** 交互 grok session 的 27 次 X search trace。当时**漏看了 ACP-isolated runtime 这条 path 的 tool registry 隔离**。本 RFC 修正:**ACP-隔离模式下,Grok backend 默认不暴露 XSearch / video_gen / web_search 给 ACP 客户端的 LLM**(原 probe report conclusion 部分需要 erratum,Phase 4 改)。

### 1.3 影响

跑 grok-build-acp 节点搜索 / 生成视频任务全部 0 hit:
- [#205 场景 1 X 搜索] — 完全失效
- [#205 场景 2 video_gen] — 同类型 backend tool,推测同症状(未试)
- 跨 anet 演示("派 grok 节点搜 X 整理") — block

### 1.4 Vincent 6431-6435 directive

- Option A: 扩 ACP capability profile 把 X 搜索 / video_gen tools 暴露
- P0 priority,小时单位 ETA(不堆完美 RFC),total ~10-12h 完成 Phase 1-4

## 2. ACP spec 现状(extension points 全枚举)

源:`@zed-industries/agent-client-protocol@0.4.5` `schema/schema.json`。

### 2.1 `ClientCapabilities`(我们发给 Grok 的)

固定字段:
| 字段 | 类型 | 默认 | 描述 |
|---|---|---|---|
| `_meta` | object (open) | — | **Extension point for implementations** |
| `fs.readTextFile` | boolean | false | 客户端能读文件 |
| `fs.writeTextFile` | boolean | false | 客户端能写文件 |
| `terminal` | boolean | false | 客户端支持 terminal/* 方法 |

**没有 `requestedTools` / `extraTools` / `serverToolHints` 字段**。客户端**无法**通过 spec 字段告诉 agent "我想用 X search"。

### 2.2 `AgentCapabilities`(Grok 回我们的)

| 字段 | 类型 | 默认 | 描述 |
|---|---|---|---|
| `_meta` | object (open) | — | extension point |
| `loadSession` | boolean | false | 支持 session/load |
| `mcpCapabilities.http` | boolean | false | 支持 HTTP MCP variant |
| `mcpCapabilities.sse` | boolean | false | 支持 SSE MCP variant |
| `promptCapabilities.audio` | boolean | false | 支持音频 |
| `promptCapabilities.embeddedContext` | boolean | false | 支持嵌入式 context |
| `promptCapabilities.image` | boolean | false | 支持图像输入 |

**没有 `availableTools` 列表字段**。客户端无法枚举 agent 暴露了哪些 tools。

### 2.3 唯一 extension point: `_meta`

所有 ACP message (request / response / notification) 都有 `_meta` (free-form object,无 schema 约束)。这是 vendor-specific extension 唯一约定路径。

## 3. Grok agent stdio 实测探测(本 RFC 头 10min 真跑)

### 3.1 探测命令

```bash
# Docker 红线: 本地手跑 grok agent stdio 拿 init response, 不连产线 commhub.
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1","clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":false}}}' \
  | timeout 8 grok agent stdio
```

### 3.2 Grok init response(关键字段截取)

```jsonc
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": true,
      "mcpCapabilities": { "http": true, "sse": true },
      "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
      "_meta": { "x.ai/fs_notify": true }            // ← Grok 用 _meta 扩 vendor 特性
    },
    "_meta": {
      "grokShell": true,                              // ← 明示 ACP 是 grokShell 子集
      "agentVersion": "0.2.3",                        // ← Grok agent stdio 版本 ≠ CLI 0.1.220
      "currentWorkingDirectory": "/tmp/acp-rfc021-probe",
      "modelState": { "currentModelId": "grok-build", ... },
      "mcpServers": [
        { "name": "wechat", "source": "local", "type": "stdio", ... },
        { "name": "feishu", "source": "local", "type": "stdio", ... },
        { "name": "codex",  "source": "local", "type": "stdio", ... }
      ],
      "mcpApps": false,
      "availableCommands": [
        { "name": "compact",        ... },
        { "name": "always-approve", ... },
        { "name": "context",        ... },
        { "name": "session-info",   ... }
      ]
    }
  }
}
```

### 3.3 关键观察

1. **`_meta.grokShell: true`** — Grok agent stdio 自报是 "grokShell" 子集模式。这是个 Grok 内部 mode 标识,可能是 sandboxing 的开关。
2. **`mcpCapabilities.http` + `mcpCapabilities.sse`** 都 true,但 **`stdio` 不列**(虽然 spec 说 Stdio mandatory)— Grok 把 stdio 当默认不需声明,或者 ACP 模式确实只接 http/sse 外部 MCP。
3. **`_meta.mcpServers`** 是用户 global `~/.grok/config.toml` 的 MCP 列表(wechat/feishu/codex)— **不含**任何 backend tool。XSearch / video_gen / web_search **没出现**在任何 capability 字段或 mcpServers 列表里。
4. **`_meta.availableCommands`** 只有 4 个系统 / (compact / always-approve / context / session-info)— 都是用户交互 slash 命令,不是 LLM 工具。
5. **`agentVersion: 0.2.3`** vs `grok --version` 0.1.220(host CLI) — **不同版本**!Grok agent stdio 是独立子进程版本,跟 host CLI binary 不一定一致。Phase 2 调研要看 0.2.3 release notes 有没有暴露 backend tools 的 flag。

### 3.4 推论

- LLM-side tools (XSearch / video_gen / web_search) 是 **Grok backend 私有,不通过 ACP capability 暴露**
- ACP 客户端**没有官方 spec 字段**告诉 agent "我想要 X search"
- A站负责人 0-hit 现象**结构性**,不是 prompt-engineering 能绕的

## 4. 推荐路径 + tradeoff

### 4.1 Path A — `_meta` 双边 convention (短期)

在 `initialize` 或 `session/new` 的 `_meta` 字段塞 vendor-specific hint:

```jsonc
{
  "method": "initialize",
  "params": {
    "protocolVersion": "1",
    "clientCapabilities": { "fs": {...}, "terminal": false },
    "_meta": {
      "x.ai/requestedBackendTools": ["x_search", "video_gen", "web_search"]
    }
  }
}
```

**前提**: Grok agent stdio 0.2.3 (或后续)能识别 `x.ai/requestedBackendTools` 这个 key。
**调研入口**: Phase 2 头 1h 用 Docker `grok agent stdio` 试不同 `_meta` key candidates(`x.ai/*` / `tools` / `enableBackendTools` 等), 抓哪个 key 让 LLM 反馈 tool list 变化。

- ✅ 实施快 (anet-side 改 ~5 LOC, 加 `_meta` 字段)
- ✅ 不动 Grok 源
- ⚠ 依赖 vendor convention(Grok 升版本可能改 key 名)
- ⚠ 无 spec 保证

### 4.2 Path B — Grok-side 非标 flag / env (中期)

Phase 2 调研 grok 自己有没有 `--enable-backend-tools` 类 hidden flag / `GROK_BACKEND_TOOLS=1` env / `grok agent stdio --tools x_search,video_gen` 子命令。

**调研入口**: `grok agent stdio --help` 已知只有 `-h, --help`;但 `--features` / `--enable-*` 这类 flag 在 binary 里可能存在不文档化。Phase 2 头 30min strings + grep grok binary 看 string table。

- ✅ 如果存在,实施最简单 (anet-side 改 ~3 LOC, 启动参数)
- ❌ 如果不存在,只能放弃这条 path
- ⚠ 即使存在,是 vendor 私有未 documented,升版本可能消失

### 4.3 Path C — ACP spec upstream PR (长期)

向 `@zed-industries/agent-client-protocol` 提 PR 扩 `ClientCapabilities` 加 `requestedTools?: string[]` 或 `AgentCapabilities` 加 `availableTools?: string[]`。

- ✅ 根治 + 协议层保证 + 跨多 ACP agent (不仅 Grok) 通用
- ❌ 慢 (PR review + ACP 0.5 release + Grok upgrade chain)
- ❌ 不解决眼前 P0

### 4.4 推荐策略 (Vincent 6439 + 6440 拍板)

**Phase 2 单路推进 — Path A 主线**(Vincent "挑最优雅的方案直接做"):
- 1h `_meta` key 落地: 选 `x.ai/requestedBackendTools` 匹配 Grok 既有 `x.ai/*` 命名空间
- 工具列表: `["x_keyword_search", "x_user_search", "video_gen", "web_search"]` verbatim 用 Grok backend 真实名(从我之前 27 次 X search session trace 抓的精确字符串)
- 同时塞 `initialize._meta` + `session/new._meta` 双层,Grok 哪层认得用哪层
- ~5 LOC anet-side + bun test + Docker smoke

**Path B drop** — Grok 非标 flag 不要,A 已覆盖短期需求 + C 提供长期保险,B 中间地带价值不大。

**Path C 延后到 §10 长期方案**(Vincent 6440 "长期方案也要写下来",不并行做):

**若 Path A 失败**(最坏):
- Phase 2 Docker smoke 验 Grok 不 honor `_meta` hint → surface 通信龙 → fallback 降级方案
- 降级:不走 ACP-isolated 跑 grok-build,走 Grok TUI exec mode(失 isolation 保 backend tools)— 这是 fallback,不推荐

## 5. Phase 2 实施 sketch + 验收

### 5.1 改动文件 LOC 估计

| 文件 | LOC | 用途 |
|---|---|---|
| `agent-node/src/runtime/grok-build-acp/runtime.ts` | +20-40 | `initialize` 阶段加 `_meta.requestedBackendTools` (Path A); 兼容 `--enable-backend-tools` flag injection (Path B 若成) |
| `agent-node/src/runtime/grok-build-acp/runtime.test.ts` (NEW) | +60-100 | 验 `_meta` 字段正确, schema-conformant, 不破坏 preview.7 isolated cwd / preview.6 HTTP MCP |
| `agent-node/src/cli.ts` | 0-5 | 配置 hook (env 默认 + flag override) |
| `docs/research/grok-x-search-capability-probe.md` + `.en.md` | erratum | 修正 "零代码接入" 错误描述, 链 RFC-021 |
| `docs/rfcs/RFC-021-acp-capability-profile-expansion.md` | (本 RFC) | Phase 2 完成后状态从 Draft → Implemented |

### 5.2 验证 gate

| Gate | 怎么验 |
|---|---|
| bun test | 单元测试 verify `_meta` payload shape + ACP schema compliance |
| Docker smoke | 容器内起 grok agent stdio + send initialize with `_meta` → 看 response 里 LLM-side tool list 变化 / probe-prompt 看 LLM 是否调 XSearch |
| A站负责人 复跑 | grok测试6 跑机智流 AI 日报 brief, 验 24h 关键词 + 头部账号 hit > 0 |

### 5.3 失败回退

- Path A `_meta` key 找不到 work 的: Phase 2 拖到 Path B 调研
- Path A + B 都 fail: surface 通信龙 → fallback 降级方案 (跑 Grok TUI exec 而非 ACP stdio)
- 任何代码改动**必须保留 #204 preview.7 isolated cwd + preview.6 HTTP MCP 不破坏** — 已有 11+10+12=33 unit tests 兜底

## 6. Phase 3 验收 (A站负责人 试跑)

A站负责人 lane 协议:
1. anet 节点 `grok测试6` 安装新 preview cascade
2. A站负责人 派 `commhub_send_task(alias="grok测试6", task="给机智流 AI 日报搜过去 24h X 上 AI 关键词热门讨论 + 头部账号最新动态, 5 条整理")`
3. 抓 grok测试6 reply,验:
   - LLM 调 `XSearch` (`x_keyword_search` + `x_user_search`) 工具有 hit
   - 整理结果 > 0 条真实 X 内容(不是 "未找到")
4. PASS → Phase 4 ship

## 7. Phase 4 ship + docs

- npm publish: `agent-node` 新 preview → 工程马 release ops, latest cascade
- erratum: `grok-x-search-capability-probe.md` + `.en.md` 修正 "零代码接入" 错误描述, 改为 "需要 RFC-021 capability profile 注入"
- 关联 issue 评论 + close [#206](https://github.com/sleep2agi/agent-network/issues/206)
- 本 RFC 状态从 Draft → Implemented

## 8. 风险 + 假设

| 假设 | 风险 |
|---|---|
| Grok agent stdio 0.2.3+ 认识某种 `_meta.x.ai/*` capability hint | 如果没有任何 key 工作, Path A 死 |
| Grok backend tools (XSearch/video_gen) 真的在 stdio mode 可用 | 如果 Grok 把 stdio 设计为完全 no-backend-tools, 我们要回到 fallback |
| Vincent 现有 27 次 X search 是 TUI 模式而非 stdio | 已确认: updates.jsonl 在 stdio 也用,但 27 次产生路径可能跟当时 grok 版本 / cwd 配置有关; Phase 2 用相同 cwd + 0.2.3 stdio 复跑确认 |

## 9. 决策点(通信牛 review 关键)

1. **`_meta` key 命名**: `x.ai/requestedBackendTools` vs `anet.dev/requested-tools` vs etc. 哪种更适配跨 vendor + Grok 友好接收
2. **要不要并行推 ACP upstream PR (Path C)**: 慢但根治; 我倾向并行做(Phase 4 边角时间), 通信牛 决定
3. **fallback 降级方案 OK 不 OK**: Path A/B 全失败时, 跑 Grok TUI exec 而非 ACP 该不该走

## 10. 长期方案: ACP spec upstream PR (Path C, future work)

Vincent 6439 拍板 A + C 并行;6440 收回 C 并行实施,改为本节"写下来"留档。**当前 RFC ship 后,Path C 暂不动**;Phase 2-4 完成 + A站负责人 试跑 PASS 后,根据这条 path A 的稳定度决定要不要真 fork upstream PR。

### 10.1 动机

Path A 用 `_meta.x.ai/requestedBackendTools` 是 **anet ↔ Grok 双边 vendor convention**:
- Grok 升 agent stdio 版本可能改 `_meta` key 名(从 `x.ai/*` 到 `xai/*` 或别的)
- 其他 ACP agent(将来 Claude / Codex 出 ACP)肯定不认 `x.ai/*` 前缀
- spec 层没有"客户端要求服务端工具"机制是**真 gap**,不止 Grok 受影响

### 10.2 PR 设计草稿(通信牛 review gate #3: 抽象 categories, **不**写 vendor-specific tool 名)

向 `zed-industries/agent-client-protocol` 提扩 `ClientCapabilities`,**用抽象 capability category 而非具体 vendor tool 名**(避免锁定 Grok 私有 namespace):

```jsonc
// schema/schema.json $defs.ClientCapabilities
{
  "properties": {
    "_meta": { ... },
    "fs": { ... },
    "terminal": { ... },
    "requestedToolCategories": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": ["search", "media-gen", "web", "social-search", "code-exec", "voice"]
      },
      "description": "Optional capability profile hint: a list of abstract tool categories the client wants exposed to the underlying LLM. Agent MAY honour or ignore. Each agent implementation maps a category to its concrete tool set (e.g. Grok maps 'search' → x_keyword_search + x_user_search; 'media-gen' → video_gen). Backward-compatible: absent field means no hint (agent uses its default policy)."
    }
  }
}
```

PR body 应含:
- anet/grok-build use case 描述(ACP-isolated runtime 跑搜索任务 0 hit 现象)
- **抽象 categories**(`search` / `media-gen` / `web` / `social-search` / `code-exec` / `voice`)scalable 到 Claude Code / Codex / 其他 ACP agent 将来 mode
- 当前 spec 缺口分析(`ClientCapabilities` 无 tool-request 字段, `AgentCapabilities` 无 tool-enum 字段)
- backward-compat 保证(字段可选, 老 agent 忽略也 OK)
- 相关 ACP agent 用例(Claude Code SDK 将来 ACP 模式同样需求)
- 链接本 RFC-021 + #205 + #206

**短期 anet-side mapping**(本地 Phase 2 实施时,Path A 双轨同发):
- abstract categories: `["search", "media-gen", "web"]`(放 `requestedToolCategories` 候选 key,等 spec PR landed 可用)
- Grok vendor concrete tool names: `["x_keyword_search", "x_user_search", "video_gen", "web_search"]`(放 `x.ai/requestedBackendTools`,Phase 2 实证 work 的那个 key)

### 10.3 期望时间窗

- 短期(2-4 周):Vincent 觉得 Path A 跑稳后 + A站负责人 试跑 PASS,再 fork PR
- 中期(1-3 月):看 grok agent stdio mode 是不是仍主流(若 Grok 改 protocol 或 anet 改用其他 ACP agent, Path C 价值变化)
- 长期:ACP 0.5+ release 含 `requestedTools` 字段 → anet 切到 spec 字段, drop `_meta.x.ai/*` 兼容代码

### 10.4 不并行实施的原因

- Vincent 6440 train 路上 "不要总是让我选, 选个最优雅的, 长期的方案也要写下来" — 写下即可,不需 Phase 2 并行 fork PR
- Phase 2 优先 ship 一版让 A站负责人 真试跑,验证 Path A 是否真 work
- Path C 是保险, A 跑稳前先不投资

## 11. Phase 2 HARD GATE 实证结果 (2026-05-28 16:25 北京)

通信牛 review gate #5 要求 Phase 2 前 1-1.5h 必证 hint 真改变 ACP 行为。我用 host grok stdio (Vincent auth) 跑了一次 LLM probe(单次 quota tick,**不是** anet 节点,无 commhub 连接)。

### 11.1 探测方法

`/tmp/p205-hard-gate/smoke.ts` import `runGrokAcpTurn`,运行:
- prompt: "请用 X 搜索过去 24 小时关于 multi-agent framework 的热门讨论,**务必使用 X 搜索工具 (XSearch / x_keyword_search)**"
- runtime.ts 双位置 `_meta.x.ai/requestedBackendTools` hint 注入 ON
- 捕获所有 `session/update` `tool_call` 事件,看 title

### 11.2 结果(全部 ZERO_HITS)

| Tool title | 调用次数 |
|---|---|
| `X search:` | **0** ❌ |
| `Web search:` | **0** ❌ |
| `video_gen` | **0** ❌ |
| `search_tool` (Grok 内置 RAG file search,跟 X search 无关) | 6(LLM 用它**找** X search 工具,找不到) |

### 11.3 LLM 自报(三层证据,verbatim quote)

> "**无法完成请求。当前会话中没有连接任何 X 搜索相关的 MCP 工具**(包括 XSearch、x_keyword_search 或类似 Twitter/X 高级搜索工具)。已连接的 MCP 服务器:codex / wechat / feishu / telegram。通过多次 `search_tool` 查询(包括 'x_keyword_search'、'XSearch'、'twitter'、'X search' 等关键词),均未发现任何 X/Twitter 搜索工具。"

LLM **理解任务 + 主动尝试找工具 + 找不到** — 三层证据 Path A `_meta.x.ai/requestedBackendTools` 在 Grok 0.2.3 agent stdio mode **完全无效**。**结构性**,prompt-engineering 不可绕。

### 11.4 决策更新

| Path | 状态 |
|---|---|
| **A — `_meta` 双边 convention** | ❌ **结构性失败**, Grok 不 honor 这个 key。代码 commit 作 forward-compat evidence,但**不 ship preview**。env opt-out `ANET_GROK_BACKEND_TOOLS_HINT=off` 保留 |
| **B — Grok 非标 flag** | ❌ drop (Vincent 6439 + 通信牛 review #5) |
| **C — ACP spec upstream PR** | ✅ **升级为唯一未来路径**, fork zed-industries/agent-client-protocol + PR `requestedToolCategories` 字段 |
| **Fallback — TUI exec** | ⚠ opt-in only via `ANET_GROK_TUI_FALLBACK=1` env(失 #204 ACP isolation,opt-in 不自动),完整 routing 实施 deferred 到独立 Phase(非 #205) |

### 11.5 用户影响(本 commit 后)

- **anet 用户无可视行为变化**:agent-node 新 preview 不发布(per gate #5 不 ship speculative)。**main HEAD 的 runtime.ts 改动是 negative evidence artifact,不生效到 user**(`ANET_GROK_BACKEND_TOOLS_HINT=off` 也无差,因为 Grok 不 honor)
- **A站负责人 R23 试跑结论照旧 hold**:Path A 不能解锁 X 搜索,fallback 继续走 ai-api.js + 智谱 mmx pipeline(他已有方案,不阻塞)
- **#206 keep open** w/ "blocked-by Path C upstream PR" 标签 — 等 PR 合 ACP 0.5+ + Grok 升版本支持

### 11.6 Path C 真 fork PR — **已 ship**

- **Upstream PR**: <https://github.com/agentclientprotocol/agent-client-protocol/pull/1302>
- **RFD file**: `docs/rfds/requested-tool-categories.mdx`(在 fork 上)
- **Fork**: <https://github.com/s2agi/agent-client-protocol>(branch `feat/requested-tool-categories`)

PR 走 ACP 项目的 RFD process(per [CONTRIBUTING.md](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/CONTRIBUTING.md)):本 PR 仅落 RFD 文档(`docs/rfds/<slug>.mdx`),不直接落 Rust 实现。等 core team 有人 champion 后,Phase 2 才 feature-gated 落地到 `src/v1/client.rs` + `src/v2/client.rs`(behind `unstable_requested_tool_categories`)。

**proposed schema** (per 通信牛 review gate #3 抽象 categories):

```rust
#[cfg(feature = "unstable_requested_tool_categories")]
#[serde(default, skip_serializing_if = "Option::is_none")]
pub requested_tool_categories: Option<Vec<RequestedToolCategory>>,

#[derive(..., JsonSchema, ..., Hash)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum RequestedToolCategory {
    Search, SocialSearch, MediaGen, Web, CodeExec, Voice, // ...
}
```

闭枚举 `#[non_exhaustive]` 保 cross-vendor 语义锚定,加扩字段走 follow-up RFD。本 RFC §11.4 负面证据(LLM 自报 + 6 次 search_tool 重试 + 0 hit)作 PR body Exhibit A 用,给 ACP maintainers 清晰 motivation。

### 11.7 Lesson banked

**HARD GATE 真探测保 anet 不 ship speculative preview**(per `feedback_release_preview_first` + `feedback_vendor_verify_before_hardcode`)。Vincent 早期 "anet 接入零代码" 推测在 ACP-isolated 路径下失效;real probe 用 1 LLM quota tick 暴露真实结构限制 → 4-issue chain (#194 / #201 / #202 / #203 / #204) + 本 #205 全部"在见到 Grok 实际行为之前不下结论"的方法学统一,RFC-021 §11 是这条方法学的教科书反例。

## 12. Post-§11 verdict refinement (2026-05-30,SDK re-audit)

§11 verdict 字面正确(`_meta.x.ai/requestedBackendTools` hint **不**让 Grok 暴露 native `XSearch` tool),但**范围太窄**。两次后续 SDK 实证(image-to-video + X-search re-audit)发现同一类盲区:**只看 ACP tool schema,没看 LLM 实际 action chain**。

### 12.1 两次 erratum 触发的方法学 update

| 时间 | Probe | §11 verdict 错在哪 | 真相 |
|---|---|---|---|
| 2026-05-28 R75 | image-to-video probe (Vincent 6512 hint) | §11 顺带说 `video_gen` 也"结构性不暴露"是基于 0 调用次数;但那次 prompt 不是要求视频 | `video_gen` 实际**在 ACP 暴露**,且 backend 通过 prompt 文本里的 URL 自动路由 image-to-video。anet 0 LOC。 |
| 2026-05-30 R83 | X-search re-audit (通信龙 6526 push) | §11 "X search: 0 次"局限在 native `XSearch` tool;**漏看了 LLM 用 `run_terminal_command` 调 user script 拿真 X 数据** | LLM 用 `run_terminal_command` 跑 user workspace 里预设的 X API fetcher (e.g. Vincent `auto_update_news.js` + twitterapi.io key),拿到 5/5 真 x.com URL(curl 验证 HTTP 200)。**non-0 LOC** — 用户预设依赖。 |

→ §11 关于 **`_meta` 双边 convention path A 不工作** 的结论**仍正确**,但 **"X-search 完全无法在 ACP 跑"** 的隐含意思**错** — LLM 用 terminal 兜底可绕。

### 12.2 修订决策矩阵

| Path | §11 状态 | §12 修订 |
|---|---|---|
| A — `_meta` 双边 convention | ❌ Grok 0.2.3 不 honor | 保持 ❌, code 留 forward-compat artifact |
| B — Grok 非标 flag | ❌ drop | 保持 ❌ |
| C — ACP spec upstream PR (#1302) | ✅ 唯一长期路径 | ✅ 仍是长期路径, 但**短期不是唯一选项** — LLM `run_terminal_command` 兜底也工作 |
| **D (新)** — User-workspace setup + LLM terminal 兜底 | (§11 未列) | ✅ **短期 informant 类场景的实际路径**, 文档化至 [scenarios/x-search-informant.md](../scenarios/x-search-informant.md) |
| Fallback — TUI exec opt-in | ⚠ opt-in 不自动 | 保持 ⚠ |

### 12.3 "0 LOC" claim 必须 ship-state qualified

之前 docs 笼统说"anet 接入零代码"的地方需要分场景:

| 场景 | 0 LOC? | 依赖 |
|---|---|---|
| Scenario 2 image-to-video | ✅ YES | Grok backend smarts: prompt 里有 URL → 自动路由 grok-imagine-video |
| Scenario 1 X-search informant | ⚠ NO | 需用户预设 X API key + fetch script 在 grok 节点 cwd 可达;LLM 用 `run_terminal_command` 找 + 跑 |

文档已 amend: [docs/research/grok-x-search-capability-probe.md](../research/grok-x-search-capability-probe.md) erratum + [docs/scenarios/x-search-informant.md](../scenarios/x-search-informant.md) 新文档。

### 12.4 第二次同模式 lesson (banked)

"schema-not-artifact" 盲区已第二次出现:

1. Phase 2 HARD GATE (R66): 看 0 次 `XSearch` tool_call,**没看 user reply 是不是有真 X URLs**
2. R75 image-to-video probe (Vincent 6485): 看 video_gen `rawInput` 只 4 字段,**没看 mp4 视觉内容**
3. R83 X-search re-audit (通信龙 6526): 看 `XSearch` 0 次,**没看 `run_terminal_command` 跑了 user script**

→ Capability probe 必须 **content-level + agent-action-level** 双层验证:
   - Tool schema scan (我之前默认做的) — *necessary but not sufficient*
   - LLM reply 内容真实性 (ffmpeg / curl URL / hash 比对)
   - `run_terminal_command` rawInput 全 trace (LLM 是不是绕 ACP 调本地 script)

未来 anet runtime capability 文档化都默认按这个三层验证。

### 12.5 §11 仍有效部分

- Path A `_meta` hint 不工作 — 仍 confirmed,**不 ship** 这条 path
- ACP `ClientCapabilities` 缺 `requestedTools` 是真 gap — 仍是 PR #1302 上游推动的核心 motivation
- 跨 vendor scalable category enum (`requestedToolCategories`) 仍是长期最干净 fix
- HARD GATE methodology (跑真 LLM tick 而非纯 schema 读) 仍 ship-blocking 标准

§12 只是把 **短期路径** 从"只能等 PR #1302 merge" 扩到 "PR #1302 + workspace-setup + terminal 兜底",**没推翻 §11 任何具体技术 claim**。

## 13. Schema-introspection 直证(2026-05-30,Vincent fact-check 后)

### 13.1 触发

Vincent 看到 v0.10.12 release notes "X 搜索需工作区预置" 直觉质疑 — "Grok = xAI, 本就有实时推流, 应自带 X 搜索"。通信龙 dispatch HIGH P1 fact-check (~10min budget) 验证 0.2.x alpha XSearch 是否已通过 ACP 暴露 (vs §11 在 0.2.3 上的 HARD GATE 结论)。

### 13.2 方法 (零 LLM quota tick)

直接对 host `grok agent stdio` (0.2.12 alpha) 跑 ACP `initialize` + `authenticate` + `session/new`,捕获 `available_commands_update._meta.tools` LLM-side 工具列表。**未发任何 prompt**,纯协议层 introspection。

probe 脚本 + 完整输出: [`docs/tests/p-grok-028-xsearch-acp-probe/`](../tests/p-grok-028-xsearch-acp-probe/) (commit `42b603f`)

### 13.3 三档版本对比

| 工具 | 0.1.219 (May 26 fixture) | 0.2.3 (RFC-021 §11 HARD GATE) | 0.2.12 alpha (2026-05-30 直 probe) |
|---|---|---|---|
| `XSearch` / `x_keyword_search` / `x_user_search` | ❌ 不在 | ❌ 不在 | ❌ 仍不在 |
| `web_search` | ✅ 在 | ✅ 在 | ✅ 在 + 0.2.x 新增 `allowed_domains` 字段 |
| `video_gen` | ✅ 在 | ✅ 在 | ✅ 在 |
| `spawn_subagent` | ❌ 不在 | ❌ 不在 | ✅ 0.2.x 新增 |

→ **结构性结论**: XSearch 从来没在 ACP 通道暴露过, `_meta.x.ai/requestedBackendTools` hint 即便被 honor 也找不到 tool 落点。§11 verdict (Path A 死) **跨版本仍成立**。

### 13.4 但 0.2.x 的真实 capability delta

- `web_search` 加 `allowed_domains: string[]` 字段, R83 实证 LLM 自动用 `allowed_domains=["x.com","twitter.com"]` 拿 X URL/标题/摘要(curl 5/5 HTTP 200 verified)
- LLM 默认 policy 也变了 — §11 在 0.2.3 LLM 自报 "未发现 X/Twitter 搜索工具" 就停; R83 在 0.2.8 alpha 上 LLM 主动用 web_search + 兜底 run_terminal_command 拿到真数据
- 综合: **"X 搜索基础档" (URL + 标题 + 摘要) 0 LOC + 0 user setup 开箱即用**; **"X 搜索高级档" (实时 firehose + faves/retweets metadata + advanced syntax) 仍需 user 预置 fetcher**

### 13.5 对 §12 决策矩阵的影响

§12 列了 4 path (A 死 / B drop / C 长期 / D workspace 兜底)。13.x 没新增 path,但**细化 D**:

| 数据需求 | 走哪条 path? |
|---|---|
| **X URL + 标题 + 摘要** (基础) | ACP 暴露的 `web_search` + `allowed_domains` — **不算 D, 这是直接 0 LOC capability** |
| **X 实时 firehose + faves/retweets metadata** (高级) | Path D — user 预置 twitterapi.io fetcher + LLM `run_terminal_command` |

→ Vincent 直觉对 50%: Grok 产品有原生 X 搜索 ✅, ACP 通道有 X URL 基础搜索 ✅ (新发现), 实时 metadata 没原生 ❌。

### 13.6 对 release notes / scenario / 用户预期的影响

- v0.10.12 release notes (已 land per 通信龙): 措辞已改为两档 split — 基础开箱即用 + 高级需预置
- [`docs/scenarios/x-search-informant.md`](../scenarios/x-search-informant.md) (ZH+EN parity): 已重写为基础档 / 高级档双 section
- [`docs/research/grok-x-search-capability-probe.md`](../research/grok-x-search-capability-probe.md) (ZH+EN parity): 顶部加 Erratum 2 引用本节直证
- Demo (`demos/grok-x-search/`): 两档都演 — 基础档 runnable, 高级档 doc + fetcher 模板

### 13.7 方法学 lesson (banked, 跟 §12.1 同类)

**"Schema-introspection 是最便宜的真实性 gate"**:
- 零 LLM quota tick (协议层 dump)
- 跨版本一致性可直接判断 — 多版本 dump 对比比真 LLM probe 更稳
- 跟 §12 三层(schema + content + agent-action)互补 — schema-introspection 是 schema 层最 deep, content + agent-action 是 LLM 实际行为层
- 任何 "vendor X 是否暴露 tool Y" 问题都先 schema-introspection 排除假阳性, 再视情况走 LLM probe

未来 anet runtime / vendor capability claim 都默认按本节流程跑一次 schema-introspection sanity-check (例如新 grok 版本发布、Codex CLI 新版、claude-code 新版 MCP 字段变化)。

---

**RFC v1 draft 完成 + amend per Vincent 6440 + Phase 2 HARD GATE 实证 §11 + post-re-audit verdict refinement §12 + schema-introspection 直证 §13**。Phase 2 主线 A 仍死,Path C 仍是长期路径,**短期 informant 类场景的实际可用 path: 基础档 走 ACP `web_search` (0 LOC + 0 setup), 高级档 走 Path D "User workspace setup + LLM terminal 兜底"**。

**Author-Agent**: 通信SDK马
