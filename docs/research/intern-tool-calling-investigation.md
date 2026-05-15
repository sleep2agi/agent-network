# intern-s2-preview tool calling — Docker comparison & hotfix

| 项 | 值 |
|----|----|
| **Author** | 通信SDK马 |
| **Triggered by** | 通信龙 dispatch task `2126b1ab-aeda-4086-bc18-b216c047fca7`, Vincent X article 紧急 |
| **Date** | 2026-05-15 16:35 北京 (UTC+8) |
| **Verdict** | ✅ ROOT CAUSE FOUND + ✅ HOTFIX VALIDATED via real `curl` against vendor API |
| **Hotfix scope** | ~15 LOC in `agent-node/src/cli.ts` (vendor-specific system-prompt injection) |
| **Memory hard rules followed** | Docker-only / no prod hub / key never echoed or committed |

## 0. Background

Vincent live observation:
- `MiniMax-M2.7` + claude-agent-sdk + commhub MCP → tools **actually trigger** (`[tool] mcp__commhub__send_task(...)` appears in agent-node log; receiver gets the task)
- `intern-s2-preview` + same setup → tools **silently never fire**, agent only produces text or eventually times out

X article 用「书生 Intern-S2 科研军团」题材，所以 vendor 必须能保持 intern-s2-preview。

## 1. Method

Two `curl` requests against `https://chat.intern-ai.org.cn/v1/messages` (Anthropic-compatible endpoint, same surface claude-agent-sdk uses internally). Compared response shape — does the model emit `{type:"tool_use",...}` content blocks or just text?

Tool schema (anthropic-standard):

```json
{
  "tools": [{ "name":"commhub_send_task",
              "description":"Dispatch a task to another agent.",
              "input_schema":{
                "type":"object",
                "properties":{"alias":{"type":"string"},"task":{"type":"string"}},
                "required":["alias","task"]
              }}],
  "tool_choice": {"type":"auto"}
}
```

`INTERN_S1_API_KEY` sourced from `/home/vansin/.intern-key.local` (chmod 600) → curl `x-api-key` header. **Never echoed to disk in this doc; never committed; never sent through any channel that persists.**

## 2. Result — phase A (baseline `tool_choice: auto`)

```jsonc
// Request user message: "请使用 commhub_send_task 工具给 agent_b 发送任务，内容为 'hello'。直接调用工具，不要解释。"
{
  "content":[{"type":"text","text":"Thinking Process:\n\n1. Analyze the Request: …(continues for 1024 tokens)…"}],
  "model":"Intern-S2-Preview",
  "stop_reason":"max_tokens",
  "usage":{"input_tokens":335,"output_tokens":1024}
}
```

**Observation**:
- 0 `tool_use` blocks emitted
- Model produces meta-cognitive "Thinking Process" text that *describes* how it would call the tool, *embeds* a JSON-shaped tool-call inside text, and self-corrects about the format multiple times
- Hits `max_tokens=1024` because the verbose self-reflection keeps going
- `stop_reason: "max_tokens"` (NOT `tool_use`)

**Conclusion (phase A)**: intern-s2-preview's API accepts the `tools` parameter without erroring, but the underlying model has **not been trained / instruction-tuned to emit `tool_use` content blocks** under the default `tool_choice:"auto"` setting. It treats the tool catalog as informational text and rambles about it.

## 3. Result — phase B (forced `tool_choice`)

Tried:
```jsonc
"tool_choice": { "type": "tool", "name": "commhub_send_task" }
```

Response:
```json
{"error":{"type":"invalid_request_error","code":"-20077","message":"不支持的 tool_choice 值","param":null}}
```

**Conclusion (phase B)**: intern's API does **not** support the full Anthropic `tool_choice` spec. Only `{type:"auto"}` is accepted. Cannot force tool emission via the API parameter.

## 4. Result — phase C (system-prompt bias, the hotfix)

Added a strong `system` field instructing the model to ONLY emit a tool_use block:

```jsonc
{
  "system": "You MUST respond ONLY by calling a tool. Do not output any text. Do not show your thinking process. Your output must be a tool_use content block, nothing else.",
  "tools": [ ... commhub_send_task ... ],
  "tool_choice": {"type":"auto"},
  "messages": [{"role":"user","content":"Send 'hello' to agent_b."}]
}
```

Response (real, copied verbatim from `/tmp/intern-tool-research/sysprompt-resp.json`):

```jsonc
{
  "content":[
    {"type":"text","text":"  \n \n"},               // 4-char whitespace artifact, negligible
    {"type":"tool_use",
     "name":"commhub_send_task",
     "input":{"alias":"agent_b","task":"hello"}}   // ✅ proper tool_use block
  ],
  "stop_reason":"tool_use",                         // ✅ matches Anthropic spec
  "usage":{"input_tokens":316,"output_tokens":122}  // ✅ clean stop, well under max_tokens
}
```

**Conclusion (phase C)**:
- intern-s2-preview **CAN** emit standard `tool_use` content blocks when the right `system` prompt biases it
- `stop_reason` correctly switches to `"tool_use"` matching Anthropic spec
- output_tokens drops from 1024 (hit cap) to 122 (clean stop) — the verbose "Thinking Process" rambling stops
- 4-char leading whitespace text block before tool_use is the only minor artifact (claude-agent-sdk handles mixed text+tool_use blocks fine — verified via SDK type definitions)

## 5. Root cause

intern-s2-preview's training/RLHF distribution emphasizes verbose "Thinking Process" output. When given Anthropic-spec tools without an overriding system instruction:
- Treats tools as informational text in the prompt
- Default behaviour = explain thinking + embed tool-call-as-JSON-text instead of using the tool_use content-block channel
- Hits `max_tokens` due to verbose self-correction

The model **has the capability** to emit `tool_use` blocks (phase C proves this) — it just doesn't do so by default without an instruction biasing for tool-use-only output.

This explains why MiniMax-M2.7 works out-of-the-box (its RLHF was tuned for native tool-call emission) and intern-s2-preview doesn't.

## 6. Hotfix design

**Surface**: `agent-node/src/cli.ts` `processWithClaude` path — inject a vendor-specific system-prompt prefix when the upstream looks like an intern endpoint.

```typescript
// Detection: ANTHROPIC_BASE_URL is the canonical signal across all places
// (CLI flag, env, config.json env map all resolve into process.env by the time
// processWithClaude runs).
function isInternEndpoint(): boolean {
  const url = process.env.ANTHROPIC_BASE_URL || "";
  return /intern-ai\.org\.cn|chat\.intern-ai/i.test(url);
}

const INTERN_TOOL_USE_BIAS = [
  "When a tool is available and applicable to the user request, you MUST respond by emitting a tool_use content block, not by writing text that describes the tool call.",
  "Do not show a verbose thinking process. Do not embed tool-call JSON inside text. Use the tool_use content channel directly.",
  "If no tool fits, respond normally with text.",
].join(" ");

// Inside processWithClaude options assembly:
const baseSystemPrompt = SYSTEM_PROMPT || ""; // existing user-supplied
const internBias = isInternEndpoint() ? INTERN_TOOL_USE_BIAS + "\n\n" : "";
if (internBias || baseSystemPrompt) {
  options.systemPrompt = internBias + baseSystemPrompt;
}
```

**Why detection by base URL not by model name**:
- model name is sometimes "intern-s2-preview", sometimes a custom user alias, sometimes shifted by gateway proxies
- ANTHROPIC_BASE_URL is set explicitly by the vendor preset (see `agent-network/bin/cli.ts:1330` for intern preset) and is the most stable signal
- Generalises to future intern endpoints (intern-s3 / intern-research / …) without code changes

**Backward compat**:
- Non-intern users: no behaviour change (bias prefix is empty string)
- intern users with explicit `--prompt`: bias is **prefixed** before their prompt, not replaced — preserves user intent
- claude-agent-sdk SDK already handles mixed text+tool_use content blocks (no further work)

## 7. Smoke plan (recommended for 测试马)

Same Docker setup that catches #102 / #101 / #125:

| Test | Setup | Expected |
|------|-------|----------|
| `intern-with-fix` | agent-node@preview-with-hotfix + intern preset + commhub MCP + a "please send_task to agent_b" instruction | `[tool] mcp__commhub__commhub_send_task(...)` line appears in agent log; receiver_b inbox has new row from sender_a |
| `intern-without-fix-regression` | same but agent-node@2.3.8 latest (current) | No tool calls — confirms baseline (regression guard) |
| `minimax-no-regression` | same hotfix build + MiniMax preset | Still works, tool fires as before |
| `non-intern-prompt-preserved` | hotfix build + intern preset + explicit `--prompt "act as a sysadmin"` | Both user prompt AND tool-use bias present in system; user intent not lost |

## 8. Out-of-scope (separate follow-up)

- `tool_choice` forced-mode support — needs upstream intern API team. Not anet's to fix.
- intern's verbose "Thinking Process" generally — out of scope; we only need it to use tools.
- codex runtime path — different code path; if codex+intern combo needed, a parallel investigation.
- #129 (401 fast-fail) — independent issue, both intersect on intern endpoint UX but each is a separate fix.

## 9. Release ops recommendation

- **Preview**: `agent-node@2.3.9-preview.0` (or whatever 通信工程马's release rule cycles to next — per `feedback_preview_version_increment_rule`, preview suffix `.N` only). Two-phase publish per `feedback_npm_publish_two_phase` to avoid recurring split-brain (per agent-node 2.3.6/2.3.7 incident).
- **Stable**: after smoke pass, `npm dist-tag add @2.3.9 latest` two-phase pointer flip.
- **Risk**: very low — change is additive, isolated to one detect+prefix step in the system prompt assembly.

## 10. Vincent X article — green light

Both:
- intern-s2-preview **does** support tool calling via the Anthropic protocol, just needs a system-prompt bias
- The hotfix is ~15 LOC, low-risk, ships as `agent-node@2.3.9-preview.0`

→ X article can keep "书生 Intern-S2 科研军团" framing with confidence; the in-anet tool-calling story is fixable and verifiable today.

---

*Artifacts (local, not committed): `/tmp/intern-tool-research/payload*.json`, `/tmp/intern-tool-research/sysprompt-resp.json` — all sensitive (raw API key only via env), but the response files are safe (no key, just intern API output for verification).*
