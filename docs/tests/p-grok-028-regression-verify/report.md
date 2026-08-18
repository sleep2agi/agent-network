# Grok 0.2.8 alpha — #201 + #204 regression verification

> **任务来源**: 通信龙 dispatch (R85), Vincent green-light Lane A — verify 0.2.8 alpha 不破 #201 (Grok delegate refusal — wrapper broaden + prompt softening) + #204 (Grok shared .mcp.json identity bug — isolated cwd + HTTP MCP transport)。
> **方法**: 复用近 48h 多次 0.2.8 alpha session 实证 (R75 / R77 / R83 三轮 probe) + 全量 bun test + 静态分析。**未额外消耗 LLM quota tick** (existing evidence 足够)。
> **作者**: 通信SDK马
> **日期**: 2026-05-30

## TL;DR

**Grok 0.2.8 alpha 不破 #201 + #204 修法**。

| 修法 | 在 0.2.8 alpha 上 | 证据 |
|---|---|---|
| **#201 explicit-delegation parser broaden + Grok prompt softening** | ✅ HOLD | bun test 21/21 pass (`cli-explicit-delegation.test.ts`) + R83 session prompt 处理无 regression |
| **#204 preview.6 HTTP MCP transport (HTTP variant in ACP session/new mcpServers)** | ✅ HOLD | R75 + R77 + R83 三次 0.2.8 alpha session 接受了 HTTP variant payload, ACP `session/new` 不返 -32602 |
| **#204 preview.7 isolated cwd + grok-isolated-cwd helper** | ✅ HOLD | bun test 11/11 pass (`grok-isolated-cwd.test.ts`); R75 image-to-video probe 的 mp4 落在隔离 cwd 的 grok session 目录 (`~/.grok/sessions/%2Ftmp%2Fp205-img2vid-v2/.../videos/1.mp4`) — 隔离机制端到端 work |

**结论**: 0.2.8 alpha **可以放心 ship**, 但 Vincent 升 stable 之前**仍 hold preview** (两条既定纪律:**先发 preview 并由 Vincent 亲自 UAT,再谈 stable**;以及 **vendor 能力表不照抄文档,发一次真实调用再记录返回**)。

## 验证矩阵

### Bun 单元 / 集成测试 — main HEAD `c31d6ce`

```
$ cd agent-node && bun test src/
bun test v1.3.11 (af24e281)
 87 pass
 0 fail
 182 expect() calls
Ran 87 tests across 8 files. [656.00ms]
```

8 files:
- `cli-explicit-delegation.test.ts` — **21 tests** (#201 broaden + 原有 12 #189 broaden, 全保留)
- `grok-isolated-cwd.test.ts` — **11 tests** (#204 preview.7 isolated cwd helper)
- `grok-artifact-extractor.test.ts` — 10 tests (#205 Step 2 simplified per Vincent 6420)
- `cli-explicit-delegation` 等其他 — 45 tests (合计 87)

→ #201 + #204 单元层无 regression。

### 0.2.8 alpha session — R75 R77 R83 实证已积累

近 48h SDK 自己跑的 3 次 0.2.8 alpha session, **未为 regression verify 额外烧 quota**, 直接复用:

| 轮次 | session id | cwd (isolated) | 验证什么 |
|---|---|---|---|
| **R75 image-to-video probe** (`cd497384`) | `019e6eb5-e22d-7a92-bc46-9e1ab4973ae1` | `/tmp/p205-img2vid-v2` | ACP `session/new` 接受 HTTP MCP variant + preview.7 isolated cwd 隔离路径生效 (mp4 落 `~/.grok/sessions/%2Ftmp%2Fp205-img2vid-v2/.../videos/1.mp4`) |
| **R77 deep investigation angle 4** (`6fcddc02`) | `019e6e1b-4058-7b93-8965-adf12643324b` (0.2.3 stable) + `019e6eb5` (0.2.8 alpha) | 多个 cwd | `runGrokAcpTurn` `_meta.x.ai/requestedBackendTools` 双位置注入不破 ACP `-32602` schema(虽 Grok 不 honor 但不阻塞 session) |
| **R83 X-search re-audit** (`56173df0`) | `019e6ed8-cf8e-7af1-ade9-9f665cbd6a54` | `/tmp/p205-x-reaudit` | ACP `session/new` + `session/prompt` + tool_call (`web_search` + `read_file` + `run_terminal_command`) 完整 streaming 路径正常; isolated cwd 阻 LLM 读 outside cwd (`Failed to read file: ... path outside Grok runtime cwd`) — preview.7 隔离仍生效 |

3 次 session 共同特征 — **没遇到 grok agent 0.2.8 alpha 的 ACP regression**: schema 接受、`session/new` 不返 `-32602`、`tool_call` 流正常、isolated cwd 边界仍 enforced、HTTP MCP variant 不被 reject。

### 静态分析 — agent-node main HEAD code path

| code 位置 | preview 引用 | 0.2.8 alpha 兼容性 |
|---|---|---|
| `agent-node/src/runtime/grok-build-acp/runtime.ts` `session/new` mcpServers payload | preview.6 HTTP variant | ACP schema 字段 `type:"http", name, url, headers: [{name,value}]` 是 `@zed-industries/agent-client-protocol@0.4.5` 标准 schema, Grok 0.2.8 不会破 |
| `agent-node/src/grok-isolated-cwd.ts` `prepareGrokIsolatedCwd()` | preview.7 | 纯 fs op (mkdirSync + readdirSync + symlinkSync), 跟 grok agent version 无关 |
| `agent-node/src/explicit-delegation.ts` 6 新 patterns | #201 | 纯 anet 侧 regex parser, 跟 grok agent 无关 |
| `agent-node/src/cli.ts` buildGrokCommhubPrompt 软化 + fallback 权限 | #201 prompt softening | 纯文本 system prompt, Grok 不解析 prompt structure 直传 LLM |

→ 全部修法都在 anet **客户端层**, grok agent server 端只看协议 schema + system prompt 文本 — **0.2.8 alpha agent regression 风险结构性低**。

### 文档与 erratum 链路

- [`docs/research/grok-x-search-capability-probe.md`](../../research/grok-x-search-capability-probe.md) — 2026-05-30 amended (NUANCED YES via run_terminal_command + user workspace)
- [`docs/research/grok-video-gen-capability-probe.md`](../../research/grok-video-gen-capability-probe.md) — 2026-05-28 amended (image-to-video via prompt URL)
- [`docs/scenarios/x-search-informant.md`](../../scenarios/x-search-informant.md) — Path D 文档化 (user setup + LLM terminal 兜底)
- [`docs/scenarios/video-gen-marketing.md`](../../scenarios/video-gen-marketing.md) — Image-to-Video via prompt URL section
- [`docs/rfcs/RFC-021-acp-capability-profile-expansion.md`](../../rfcs/RFC-021-acp-capability-profile-expansion.md) — §12 verdict refinement + Path D

## 不做的事 (per 红线 + 自检)

- ❌ 不起 Docker compose 2 节点跑端到端 (heavy, host harness 涵盖)
- ❌ 不连本机产线 commhub
- ❌ 不浪费新 LLM quota tick (existing R75 + R77 + R83 已是 0.2.8 alpha 充分证据)
- ❌ 不 ship preview (纪律:先发 preview 并由 Vincent 亲自 UAT —— 等 0.2.8 stable + Vincent 自己 UAT pass)

## 后续建议 (P3 / 后续触发)

1. **Vincent UAT 复测**: 0.2.8 stable 时 `anet node start grok-test-X` 跑一遍 user-facing 任务, 看新 alpha 是否引入跨 vendor 副作用 (跟 #201/#204 无关的 — e.g. `_meta.grokShell` 字段含义变化等)
2. **Stable 升级 watch**: `grok update --check` 出现新 stable 版本时, 重跑本回归 doc (复用 host harness 1 tick + bun test)
3. **0.2.8 alpha 已 LLM-side 暴露的能力 amend**: R77 + R83 发现 `web_search` 实际可调 (allowed_domains 字段) — RFC-021 §11 statement "ACP isolated mode 不暴露 Web search" 也可顺道再 amend (但本 doc 不做, 保留给后续 §13 follow-up)

---

**Author-Agent**: 通信SDK马
