# Vendor Adapters

> ⚠ **New since v0.9.1** (agent-node v2.3.9-preview.0+, introduced by hotfix [#130](https://github.com/sleep2agi/agent-network/issues/130))

agent-node's `claude-agent-sdk` runtime is an Anthropic Messages API client, so **in theory** any Anthropic-compatible endpoint (InternLM / DeepSeek / GLM / Kimi / MiniMax / OpenRouter / self-hosted lmdeploy …) should just work. **In practice**, each vendor's RLHF fine-tuning takes its own path, and the same Anthropic-protocol payload produces **behavioral divergence** across vendors:

- MiniMax / Anthropic native: tool calls work out of the box; `stop_reason: "tool_use"`, content blocks correct
- InternLM intern-s2-preview: accepts the `tools` parameter but under `tool_choice: "auto"` defaults to verbose "Thinking Process" free-form text — **does not emit** `tool_use` content blocks. Forcing `tool_choice: {type:"tool", name:...}` is rejected with `-20077 不支持的 tool_choice 值`.

To stop users getting stuck on "the same prompt works on MiniMax but not on Intern", agent-node introduces **vendor adapters**: detect the vendor by `ANTHROPIC_BASE_URL` and prepend a tailored system-prompt bias that nudges the model's RLHF behavior back to Anthropic-standard.

---

## Current adapters

### intern (InternLM 书生)

**Trigger condition**: `ANTHROPIC_BASE_URL` matches the regex `/intern-ai\.org\.cn|chat\.intern-ai/i` ([agent-node/src/cli.ts processWithClaude](https://github.com/sleep2agi/agent-network/commit/4cd0024)).

**Injection**: a short bias is prepended **before** the user's system prompt, instructing the model to emit `tool_use` content blocks directly and skip the verbose thinking process.

**Effect** (verified by direct curl; full data in the [research report](https://github.com/sleep2agi/agent-network/blob/main/docs/research/intern-tool-calling-investigation.md)):

| Dimension | Without adapter (agent-node ≤ 2.3.8) | With adapter (v2.3.9-preview.0+) |
|---|---|---|
| `stop_reason` | `max_tokens` (free text capped at limit) | `tool_use` (clean stop) |
| `output_tokens` | 1024 (saturated) | 122 (concise) |
| `content[1]` | No tool_use block | `{type:"tool_use", name:"commhub_send_task", input:{...}}` ✅ |
| Multi-agent coordination | Tasks often fail to dispatch — hub sees no `send_task` | Dispatch closes the loop |

**Generalises**: the detection regex matches both `intern-ai.org.cn` and `chat.intern-ai` subdomains, so future intern-* endpoints don't need code changes.

---

## ⚠ Side effects (must read)

The vendor adapter is the **minimum viable fix for an RLHF bias**, not a free lunch. Five known user-visible side effects:

### 1. Loses Intern's "Thinking Process" transparency

The bias makes the model **skip the thinking stage** and emit tool_use directly — flattening one of intern-s2-preview's signature features (visible chain-of-reasoning). You can't see the model's decision reasoning when debugging.

**Migration hint**: to keep thinking visible, start with `anet node start <alias> --prompt "your system prompt"` — your prompt **replaces** the default bias, and the model reverts to its original RLHF behavior.

### 2. Detection fragility — URL regex only matches the chat.intern-ai.org.cn family

The regex `/intern-ai\.org\.cn|chat\.intern-ai/i` is a plain string match. Three edge cases bypass the bias:

- Self-hosted lmdeploy + InternLM2.5 (base URL like `http://your-server:23333`)
- Intern behind a proxy (`https://your-proxy.com/intern`)
- Aggregators (OpenRouter / your own gateway) routing to intern models

In these cases the bias **never fires** and tool calling stays broken.

**Migration hint**: for self-hosted / proxy setups, copy the bias content into a `--prompt` manually. The exact bias content is in [agent-node source — commit 4cd0024](https://github.com/sleep2agi/agent-network/commit/4cd0024) (~10 lines).

### 3. Silent injection — the bias is invisibly prepended to your system prompt

The bias is an **implicit injection** — when you customize a system prompt, you don't know it's there.

**Typical debugging confusion**: "I wrote prompt X but the model behaves like Y, why isn't it listening?" — because what actually ran was `<bias> + <your X>`.

**Migration hint**: `anet info <alias>` already prints `tools:` + `flags:` lines (companion to [#101's create banner](https://github.com/sleep2agi/agent-network/issues/101)). A polish-gap follow-up plans to add `bias_active: true/false` to make the bias state explicit.

### 4. Forced tool-calling style — bias says "MUST emit tool_use"

The bias's core instruction is "**must** emit tool_use". This is net positive for **multi-agent coordination** (agents dispatching tasks to each other). It's a drag on **single-agent report generation** (you want the model to write a markdown summary, not call tools) — the model becomes over-eager to invoke tools instead of producing text.

**Typical use-case skew**: you ask an intern agent to write a weekly report, but the bias makes it frantically try to call `Read` / `WebFetch` instead of writing prose.

**Migration hint**: for single-agent report tasks, pass your own system prompt with `anet node start <alias> --prompt "Only produce reports; do not call tools."` — that disables the default bias.

### 5. Fewer tokens out = less explainability

Same root cause as #1: intern's default output saturates 1024 tokens (verbose reasoning) → with the bias it cleanly stops at 122. A clean tool-call chain is good, but you lose insight into **why** the model decided this way.

**Migration hint**: a verbose mode (preview gap) is planned to dump the model's full raw response. For now, anytime you need model-thinking visibility, fall back to a custom `--prompt` (same as #1) to revert to native RLHF.

---

## Opt-out: pass your own `--prompt`

```bash
# Disables intern adapter default bias (replaces it with your prompt)
anet node start my-intern-agent --prompt "You are a careful code reviewer. Only call tools when the user explicitly asks."
```

Note: `--prompt` **replaces** rather than **appends** — the vendor adapter bias is no longer prepended. If you want both the bias and your own instructions, you currently need to copy the bias content into your `--prompt` and concatenate.

The prompt can also be persisted in the `prompt` field of `.anet/nodes/<alias>/config.json` (agent-node reads it via `loadProfile`).

---

## Future polish (open gaps)

Aligned with the follow-up gaps listed in [#130's engineering code trace](https://github.com/sleep2agi/agent-network/blob/main/docs/research/intern-tool-calling-code-trace.md):

- **P1** `anet info <alias>` to print `bias_active: true/false` — make silent injection explicit
- **P1** `--no-vendor-bias` flag — turn off the bias without replacing the system prompt
- **P2** Verbose mode (`--log-level debug` chain?) — dump the model's raw response including the thinking process
- **P2** Self-hosted / proxy detection fallback — detection beyond URL regex (model name / startup banner probe?)

---

## References

- Hotfix commit: [`4cd0024 fix(#130): intern-s2-preview tool calling via system-prompt bias`](https://github.com/sleep2agi/agent-network/commit/4cd0024)
- Issue: [#130 intern tool-calling broken on Anthropic protocol](https://github.com/sleep2agi/agent-network/issues/130)
- 通信SDK马 direct-curl A/B research (191 lines): [`docs/research/intern-tool-calling-investigation.md`](https://github.com/sleep2agi/agent-network/blob/main/docs/research/intern-tool-calling-investigation.md)
- 通信工程马 3-layer code trace (183 lines): [`docs/research/intern-tool-calling-code-trace.md`](https://github.com/sleep2agi/agent-network/blob/main/docs/research/intern-tool-calling-code-trace.md)
- Context: [CHANGELOG v0.9.0 Recovery & Observability](/en/changelog#v0-9-0-recovery-observability) + [Security `Tool Permissions`](/en/concepts/security#tool-permissions-default-claude-code-preset-user-responsibility)
