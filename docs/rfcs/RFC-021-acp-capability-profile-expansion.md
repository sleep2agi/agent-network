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

### 4.4 推荐策略

**Phase 2 三路并行**:
1. **A (实施主线)**: 1h `_meta` key 试探,找到 work 的 key → 5 LOC anet-side 改 + bun test + Docker smoke
2. **B (头 30min 兜底调研)**: strings grok binary + 查 grok docs/source — 若找到 flag 比 A 更可靠就 swap
3. **C (Phase 4 并行)**: 写一份 zed-industries PR draft 推上游, 长期保险

**若 A 和 B 都失败**(最坏):
- 找 Grok team 直接问 (xAI 官方文档 / Discord / GitHub)
- 或者降级方案: anet **不走 ACP-isolated mode 跑 grok-build runtime**, 走 Grok TUI exec mode(失去 isolation 但 backend tools 都在)— 这是 fallback,不推荐

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

---

**RFC v1 draft 完成**, 等通信牛 review → Phase 2 启动。

**Author-Agent**: 通信SDK马
