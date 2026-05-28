# Grok Build CLI — X 搜索能力探测报告

> **任务来源**: #205 场景 1 — 让 grok-build runtime 节点能调 Grok CLI 的 X 搜索能力作为 anet 内置 capability。
> **关联 issue**: [#205](https://github.com/sleep2agi/agent-network/issues/205) · [#206](https://github.com/sleep2agi/agent-network/issues/206) · [#204](https://github.com/sleep2agi/agent-network/issues/204)
> **探测对象**: Grok Build CLI `0.1.220 (ae5f4af53)`,默认 `grok-build` model
> **探测方法**: 静态 surface scan (`grok --help` / `grok inspect`) + Vincent 现有 session 日志 (`~/.grok/sessions/.../updates.jsonl`) 的 tool-call 痕迹解析。**未跑新 LLM** (避免消耗 xAI 配额 + 红线: 不本机生产 hub)。
> **作者**: 通信SDK马
> **日期**: 2026-05-28

## ⚠ Erratum (2026-05-28, post-SDK-re-audit) — 🟡 NUANCED YES

本报告原 Phase 2 verdict 隐含 "XSearch tool 0 次 trigger → 不支持 X 搜索" 范围窄, **错在没看 LLM 实际做了什么**.

**修正 verdict (SDK 实证 commhub `56173df0` re-audit)**: 🟡 **NUANCED YES**
- Grok backend XSearch tool 仍**不在 ACP session 中暴露** (verdict 半正确, native XSearch 路径仍 sealed)
- 但 LLM 用 `run_terminal_command` **绕过 ACP isolation**, 调用 user workspace 里已有的 X 抓取脚本拿到真 X 数据
- 实证 trace: web_search 2 次 + run_terminal_command 17 次 (含 `cat ~/.claude/skills/vincent_update-news/SKILL.md`, `head -200 /home/vansin/ai-insight/auto_update_news.js`, `node auto_update_news.js --fetch-only`)
- content verification: `curl -I` 5/5 real x.com URLs HTTP 200 (Sam Altman / OpenAI / Anthropic / FransBakker9812 / minchoi 等)

**根因 banked (第二次同模式)**: "schema-not-artifact" 盲区 — 跟 `video_gen` image-to-video 同型 (R103 erratum). probe 只看 tool schema surface 没看 LLM agent 实际 action chain.

**关键差异跟 video_gen image-to-video**:
- video_gen image-to-video: **anet 0 LOC**, prompt 含 URL 即触发 backend smarts
- X search informant: **NOT 0 LOC integration** — 需用户预先在 grok 节点 cwd 准备 X API key (twitterapi.io / official X API) + 抓取 script (e.g. `auto_update_news.js`). LLM 会用 `run_terminal_command` 找该 script 跑.

**经验**:
1. ACP isolation 不等于 LLM 完全无能 — `run_terminal_command` 是兜底通道
2. 后续 capability probe 必须 **agent-action level 验证** (跑真 LLM turn 看 tool_call 流), 不只 ACP schema scan
3. "0 LOC" claim 必须 ship-state 区分 (Scenario 2 image-to-video = backend smarts 自动路由; Scenario 1 X-search = 依赖用户 workspace setup)

**新场景覆盖**: `scenarios/x-search-informant.md` (ZH+EN) 文档化 "X search via user-side script" 用法 + setup prerequisites + LLM 行为 trace.

## TL;DR

**Grok CLI 原生支持 X 搜索**,通过 **`XSearch` tool variant** + 两个 backend-served sub-tool `x_keyword_search` / `x_user_search`。无需 anet 侧补 MCP,LLM 自行触发即可。anet 接入只需保证 **Grok 节点能正常跑 ACP session** (preview.7 已修),不需要额外把搜索能力暴露给 LLM。

## 关键发现

### 1. CLI 命令面 — 无 `grok x` / `grok search` 子命令

```bash
$ grok video --help
error: unrecognized subcommand 'video'

$ grok --help    # 子命令列表
  agent / completions / export / help / import / inspect / leader /
  login / logout / mcp / memory / models / plugin / sessions / setup /
  ssh / trace / update / version / worktree

$ grok --help | grep -i 'search'
  --disable-web-search   # 只有 disable flag,无 enable/configure
```

→ **没有 user-facing CLI 子命令** 直接调用搜索。搜索能力**只在 agent runtime 内部由 LLM 自主触发**。

### 2. 默认 capabilities — 在 `grok agent stdio` 启动时

从 [ACP init 响应 fixture](../../docs/tests/fixtures/grok-build/acp-stdio.jsonl):

```json
"agentCapabilities": {
  "loadSession": true,
  "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
  "mcpCapabilities": { "http": true, "sse": true }
}
```

→ 默认 capabilities **不暴露搜索作为 MCP 工具**。搜索由 Grok backend (xAI infra) 在 LLM 推理回路里自动注入,我们看到的是 tool-call 事件而非 MCP server。

### 3. tool-call 事件 — Vincent 现有 session 抓到的真实调用

从 `~/.grok/sessions/%2Fhome%2Fvansin/*/updates.jsonl` 统计 `tool_call` 标题:

| 调用次数 | tool title | 性质 |
|---|---|---|
| 83 | `search_tool` | 内置文件/记忆 search(非 X) |
| 27 | **`X search:`** | **本次目标** |
| 15 | `Web search:` | 通用网页搜索(WebSearch variant) |
| 2 | `web_fetch` | 取单一 URL |
| 2 | `video_gen` | 视频生成 ([见姊妹报告](./grok-video-gen-capability-probe.md)) |
| 73 | `use_tool` | generic dispatch |
| 40 | `run_terminal_command` | shell |
| 40 | `todo_write` | plan/todo |

→ **`X search:` 已被 LLM 自主触发 27 次**,工具成熟可用。

### 4. `XSearch` 请求 / 响应 schema

#### 触发(我们看到的 outbound ACP `tool_call`)

```jsonc
{
  "sessionUpdate": "tool_call",
  "title": "X search:",
  "kind": "search",
  "status": "in_progress",
  "rawInput": {
    "variant": "XSearch",
    "backend": true               // ← 在 xAI 后端执行,不走 client-side
  },
  "_meta": { "backend": true }
}
```

→ `rawInput` **不含 query 字符串**;query 由 Grok 后端从 LLM 决策中提取,客户端只看到 "search 在进行"。

#### 完成回执(`tool_call_update` status="completed")

```jsonc
{
  "sessionUpdate": "tool_call_update",
  "title": "X search:",
  "status": "completed",
  "rawOutput": {
    "call_id": "xs_call-...",
    "name": "x_keyword_search",        // ← 后端实际选择的 sub-tool
    "input": "{\"query\":\"...\",\"limit\":\"6\",\"mode\":\"Latest\"}",
    "id": "ctc_..."
  }
}
```

#### 两个 sub-tool

| sub-tool | input shape | 用途 |
|---|---|---|
| `x_keyword_search` | `{query: <X 高级搜索语法>, limit: "<N>", mode: "Latest" / 推测有 "Top"}` | 关键词 / 高级搜索(支持 `()`, `OR`, `lang:`, `since:` 等 X 原生语法) |
| `x_user_search` | `{query: <username 或 handle 模糊>, count: "<N>"}` | 按用户名找 X 账号 |

> **观察**:`limit` / `count` 都是**字符串**,不是数字。这是 Grok backend tool schema 的约定,可能跟 xAI 后端 `grok-3-latest` 系列模型的 function-calling schema 一致。

#### 实际 query 样本(来自 Vincent 真实 session)

```jsonc
// x_keyword_search 例 1 — 中文复杂条件
{"query": "(AI OR 人工智能 OR LLM OR 大模型) (中国 OR 中国AI OR DeepSeek OR 深度求索 OR Kimi OR Moonshot OR 通义 OR 文心 OR 百度 OR 阿里 OR 字节)",
 "limit": "6",
 "mode": "Latest"}

// x_user_search 例 — 按用户名搜
{"query": "vansinhu",
 "count": "5"}
```

→ 第一个例子证实 **X 高级搜索语法被完整支持**(parens + OR + 中文 keyword)。

### 5. Auth / 配额

- **Auth**: 复用 Grok CLI 登录态 (`grok login` 写到 `~/.grok/auth.json`)。无需独立 xAI API key。
- **配额**: 没有暴露的速率限制 / 用量计数 endpoint。Vincent 27 次调用都成功,推测在 Grok subscription 套餐内是常规额度。**P3 follow-up**: 触发 rate-limit 错误时 capture rawOutput 文本以确认错误格式。

## 对 anet 接入的影响

### 接入难度 — **零代码**

- Grok 节点(`runtime: grok-build-acp`)在 #204 preview.7 之后能正常跑 ACP session,LLM 已经会自主调 `X search:` 工具。
- anet 侧 **不需要补 MCP** 实现搜索能力(commhub MCP 仍按 attribution 用,跟 #204 修法一致)。
- **唯一前置条件**:Grok 节点 cwd 不被污染(#204 preview.7 isolated cwd 已修)。

### 用户使用方式 — 自然语言 prompt 即可

```
admin → commhub_send_task(alias="grok-X-探测", task="搜索过去 7 天关于 multi-agent framework 的 X 热门讨论,挑 5 条整理")
```

Grok LLM 收到任务后自主决策调用 `x_keyword_search` 或 `x_user_search`,我们透传结果即可。

### 局限

1. **不能 anet 侧调度搜索** — 因为 query 是 LLM 后端决策,client (agent-node) 看不到 query 字符串,不能做 query rewrite / quota 拦截 / cache。
2. **结果格式不可控** — `rawOutput` 只有 `call_id` + `name` + `input` 元数据,**真正的搜索结果文本以 Grok 自然语言 reply 出来**(不是结构化 JSON)。若 anet 需结构化 X data,需要额外解析 LLM reply 或者绕开 Grok 直接打 xAI API。
3. **不可关闭仅 X** — `--disable-web-search` 一次性关掉 web + 推测也包括 X(未验证)。无法只关 web 留 X。

## 建议(Step 2 设计输入)

### 2.1 anet 默认开 X 搜索

`anet node create <name> --runtime grok-build-acp` 不需要任何额外 flag,默认 Grok agent 就能调 X search。Step 2 artifact pipeline 设计文档**不需要为 X 搜索写专门接入逻辑**。

### 2.2 配额监控降级方案(P2)

若 Vincent 想看每个节点的 X 搜索消耗,Step 2 可以在 grok-acp runtime 的 `onEvent` 回调里 count `tool_call` with `kind==="search"` + title 含 `X search:`,作为 anet 内部 telemetry。**不需要修改协议**。

### 2.3 结构化 X 数据 (P3 / 看需求)

如果未来产品需要"获得 X 搜索结果的 JSON 而非 LLM 自然语言总结",建议**绕开 Grok**:
- 直接打 `https://api.x.ai/v1/chat/completions` (Live Search API,xAI 已 GA)
- 或用 `grok-3-latest` model 的 `search_parameters` 字段

但这是新一条 lane,跟本探测无关。

## Surface Map 一图流

```
┌─────────────────────────────────────────────────────┐
│  agent-node (grok-build-acp runtime)                │
│   │                                                  │
│   ├─ ACP session/new → grok agent stdio              │
│   │                                                  │
│   ↓                                                  │
│  Grok CLI subprocess (cwd = isolated, #204 fixed)    │
│   │                                                  │
│   ├─ LLM decides to search                           │
│   ↓                                                  │
│  XSearch tool variant (backend: true)                │
│   │                                                  │
│   ├─ x_keyword_search  → xAI infra                   │
│   └─ x_user_search     → xAI infra                   │
│   │                                                  │
│   ↓                                                  │
│  Result streamed back as agent_message_chunk         │
│  (自然语言总结,不是结构化 JSON)                       │
└─────────────────────────────────────────────────────┘
```

## 参考

- ACP fixture: [`docs/tests/fixtures/grok-build/acp-stdio.jsonl`](../../docs/tests/fixtures/grok-build/acp-stdio.jsonl)
- 姊妹报告: [`grok-video-gen-capability-probe.md`](./grok-video-gen-capability-probe.md)
- 上游 issue: [#205](https://github.com/sleep2agi/agent-network/issues/205) · [#206](https://github.com/sleep2agi/agent-network/issues/206)
- #204 preview.7 修法(grok cwd 隔离,本探测的前置条件): [`72e28fd`](https://github.com/sleep2agi/agent-network/commit/72e28fd)

---

**Author-Agent**: 通信SDK马
