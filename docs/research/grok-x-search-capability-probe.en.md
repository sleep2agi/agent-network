# Grok Build CLI — X Search Capability Probe

> **Source task**: #205 scenario 1 — make Grok CLI's X-search a first-class capability for `grok-build-acp` runtime nodes.
> **Related issues**: [#205](https://github.com/sleep2agi/agent-network/issues/205) · [#206](https://github.com/sleep2agi/agent-network/issues/206) · [#204](https://github.com/sleep2agi/agent-network/issues/204)
> **Subject**: Grok Build CLI `0.1.220 (ae5f4af53)`, default `grok-build` model
> **Method**: Static surface scan (`grok --help` / `grok inspect`) + parsed real tool-call traces from Vincent's existing session logs (`~/.grok/sessions/.../updates.jsonl`). **No new LLM calls** (avoid burning xAI quota + red-line: no host-side test nodes).
> **Author**: 通信SDK马
> **Date**: 2026-05-28

## ⚠ Erratum (2026-05-28, post-SDK-re-audit) — 🟡 NUANCED YES

The original Phase 2 verdict implied "XSearch tool fires 0 times → not supported" — narrow framing that **didn't observe what the LLM actually did.**

**Corrected verdict (SDK live re-audit, commhub `56173df0`)**: 🟡 **NUANCED YES**
- Grok backend's `XSearch` tool is **still not exposed inside the ACP session** (the original verdict was half-right; the native XSearch path remains sealed).
- But the LLM **bypasses the ACP isolation via `run_terminal_command`**, invoking pre-existing X-fetching scripts in the user's workspace to retrieve real X data.
- Trace evidence: web_search × 2 + run_terminal_command × 17 (including `cat ~/.claude/skills/vincent_update-news/SKILL.md`, `head -200 /home/vansin/ai-insight/auto_update_news.js`, `node auto_update_news.js --fetch-only`).
- Content verification: `curl -I` against the surfaced URLs returns 5/5 real x.com HTTP 200s (Sam Altman / OpenAI / Anthropic / FransBakker9812 / minchoi, etc.).

**Root cause banked (second occurrence of the same pattern)**: the "schema-not-artifact" blind spot — same family as the `video_gen` image-to-video Erratum (R103). The probe only inspected the tool schema surface and missed the LLM agent's actual action chain.

**Key difference vs. image-to-video**:
- video_gen image-to-video = **anet 0 LOC**, the backend auto-routes once the prompt carries an image URL.
- X-search informant = **NOT 0 LOC integration** — the user must pre-stage an X API key (twitterapi.io / official X API) and a fetcher script (e.g. `auto_update_news.js`) in the grok node's cwd. The LLM then uses `run_terminal_command` to find and run that script.

**Lessons**:
1. ACP isolation does not equal "LLM is helpless" — `run_terminal_command` is the escape hatch.
2. Future capability probes must perform **agent-action-level verification** (run a real LLM turn, observe the tool_call stream), not just ACP schema scans.
3. Any "0 LOC" claim must be ship-state-qualified (Scenario 2 image-to-video = backend smarts auto-route; Scenario 1 X-search = depends on user workspace setup).

**New scenario coverage**: `scenarios/x-search-informant.md` (ZH+EN) documents the "X search via user-side script" usage, setup prerequisites, and LLM action trace.

## TL;DR

**Grok CLI natively supports X search** via a built-in `XSearch` tool variant with two backend-served sub-tools (`x_keyword_search` / `x_user_search`). No anet-side MCP is required — the LLM autoregressively decides to call it. anet integration only needs to ensure Grok nodes can run an ACP session normally (#204 preview.7 fix), nothing else.

## Findings

### 1. CLI surface — no `grok x` / `grok search` subcommand

```bash
$ grok video --help
error: unrecognized subcommand 'video'

$ grok --help    # subcommand list
  agent / completions / export / help / import / inspect / leader /
  login / logout / mcp / memory / models / plugin / sessions / setup /
  ssh / trace / update / version / worktree

$ grok --help | grep -i 'search'
  --disable-web-search   # disable flag only, no enable/configure
```

→ **No user-facing CLI subcommand** invokes search directly. Search is **only triggered from inside the agent runtime by the LLM**.

### 2. Default capabilities at `grok agent stdio` boot

From the [ACP init fixture](../../docs/tests/fixtures/grok-build/acp-stdio.jsonl):

```json
"agentCapabilities": {
  "loadSession": true,
  "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
  "mcpCapabilities": { "http": true, "sse": true }
}
```

→ Default capabilities **do not expose search as an MCP tool**. Search is injected by the Grok backend (xAI infra) into the LLM's inference loop; what we observe is a `tool_call` event, not an MCP server.

### 3. tool-call inventory from Vincent's real sessions

Tallied `tool_call` titles in `~/.grok/sessions/%2Fhome%2Fvansin/*/updates.jsonl`:

| Count | tool title | Nature |
|---|---|---|
| 83 | `search_tool` | built-in file/memory search (not X) |
| 27 | **`X search:`** | **this probe's target** |
| 15 | `Web search:` | generic web search (WebSearch variant) |
| 2 | `web_fetch` | fetch a single URL |
| 2 | `video_gen` | video generation ([sibling report](./grok-video-gen-capability-probe.en.md)) |
| 73 | `use_tool` | generic dispatch |
| 40 | `run_terminal_command` | shell |
| 40 | `todo_write` | plan/todo |

→ **`X search:` has been called 27 times autoregressively by the LLM** — the tool is mature and routinely used.

### 4. `XSearch` request / response schema

#### Trigger (outbound ACP `tool_call` we observe)

```jsonc
{
  "sessionUpdate": "tool_call",
  "title": "X search:",
  "kind": "search",
  "status": "in_progress",
  "rawInput": {
    "variant": "XSearch",
    "backend": true               // ← executed on xAI backend, not client-side
  },
  "_meta": { "backend": true }
}
```

→ `rawInput` **does not contain the query string** — the query is decided by Grok's backend from the LLM's plan; the client only sees "search in progress".

#### Completion (`tool_call_update` status="completed")

```jsonc
{
  "sessionUpdate": "tool_call_update",
  "title": "X search:",
  "status": "completed",
  "rawOutput": {
    "call_id": "xs_call-...",
    "name": "x_keyword_search",        // ← which sub-tool the backend chose
    "input": "{\"query\":\"...\",\"limit\":\"6\",\"mode\":\"Latest\"}",
    "id": "ctc_..."
  }
}
```

#### Two sub-tools

| sub-tool | input shape | Purpose |
|---|---|---|
| `x_keyword_search` | `{query: <X advanced-search syntax>, limit: "<N>", mode: "Latest" / likely also "Top"}` | Keyword / advanced search (supports `()`, `OR`, `lang:`, `since:` etc. — native X syntax) |
| `x_user_search` | `{query: <username or handle fuzz>, count: "<N>"}` | Look up X accounts by username |

> **Note**: `limit` / `count` are **strings**, not numbers. This matches Grok's backend tool-schema convention (likely shared with the public xAI `grok-3-latest` chat-completions function-calling schema).

#### Real query samples (from Vincent's sessions)

```jsonc
// x_keyword_search example 1 — Chinese composite filter
{"query": "(AI OR 人工智能 OR LLM OR 大模型) (中国 OR 中国AI OR DeepSeek OR 深度求索 OR Kimi OR Moonshot OR 通义 OR 文心 OR 百度 OR 阿里 OR 字节)",
 "limit": "6",
 "mode": "Latest"}

// x_user_search example
{"query": "vansinhu",
 "count": "5"}
```

→ The first sample confirms **X's full advanced-search syntax is supported** (parens + OR + non-ASCII keywords).

### 5. Auth / Quota

- **Auth**: Reuses the Grok CLI login state (`grok login` writes `~/.grok/auth.json`). No separate xAI API key needed.
- **Quota**: No rate-limit headers or usage-counter endpoints observed. Vincent's 27 calls all succeeded — likely within a standard Grok subscription allowance. **P3 follow-up**: capture the `rawOutput` text format when a rate-limit error fires.

## Impact on anet integration

### Difficulty — **zero code**

- Grok nodes (`runtime: grok-build-acp`) run ACP sessions correctly after #204 preview.7, and the LLM already calls `X search:` autoregressively.
- anet **does not need to wire up an MCP** for search (commhub MCP stays as-is for attribution, per #204).
- **Only prerequisite**: the Grok node's cwd is not polluted (#204 preview.7 isolated cwd already addresses this).

### User workflow — plain-language prompt

```
admin → commhub_send_task(alias="grok-X-probe", task="Search X for the top
        5 discussions about multi-agent frameworks in the past 7 days")
```

The Grok LLM picks up the task, autoregressively decides to call `x_keyword_search` or `x_user_search`, and we relay the result. Done.

### Limitations

1. **anet cannot orchestrate the search** — because the query string is decided by the backend, the client (agent-node) never sees it; we cannot do query rewriting / quota-side throttling / caching on the client.
2. **Result format is not structured** — `rawOutput` only contains `call_id` + `name` + `input` metadata; **the actual search results come back as a natural-language LLM reply** (not structured JSON). If anet needs structured X data, additional LLM-reply parsing or bypassing Grok directly to hit the xAI Live Search API is needed.
3. **Cannot scope to "X only, no web"** — `--disable-web-search` turns off web (and probably X too, unverified) in one switch. There is no flag to disable just the web variant while keeping X.

## Recommendations (Step 2 design input)

### 2.1 anet enables X search by default — no flag needed

`anet node create <name> --runtime grok-build-acp` requires no extra flags; the Grok agent will already call X search when relevant. The Step 2 artifact-pipeline design **does not need to add explicit X-search integration code**.

### 2.2 Quota monitoring fallback (P2)

If Vincent wants per-node X-search usage telemetry, Step 2 can count `tool_call` events with `kind === "search"` and title containing `X search:` inside the grok-acp runtime's `onEvent` callback. This becomes an internal anet telemetry signal. **No protocol changes required.**

### 2.3 Structured X data path (P3 / on-demand)

If a future product feature needs "JSON X-search results rather than an LLM's natural-language summary", the recommendation is to **bypass Grok**:
- Call `https://api.x.ai/v1/chat/completions` directly (xAI's Live Search API is GA)
- Or use a `grok-3-latest` model with the `search_parameters` field

That is a separate lane unrelated to this probe.

## Surface Map (ASCII)

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
│  (natural-language summary, NOT structured JSON)     │
└─────────────────────────────────────────────────────┘
```

## References

- ACP fixture: [`docs/tests/fixtures/grok-build/acp-stdio.jsonl`](../../docs/tests/fixtures/grok-build/acp-stdio.jsonl)
- Sibling report: [`grok-video-gen-capability-probe.en.md`](./grok-video-gen-capability-probe.en.md)
- Upstream issues: [#205](https://github.com/sleep2agi/agent-network/issues/205) · [#206](https://github.com/sleep2agi/agent-network/issues/206)
- #204 preview.7 fix (Grok cwd isolation, prerequisite for this probe): [`72e28fd`](https://github.com/sleep2agi/agent-network/commit/72e28fd)

---

**Author-Agent**: 通信SDK马
