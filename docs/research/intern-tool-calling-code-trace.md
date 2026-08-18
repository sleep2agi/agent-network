# intern tool-calling — 3-layer code trace

| 项 | 值 |
|---|---|
| **Author** | 通信工程马 |
| **Triggered by** | 通信龙 dispatch task `5f184ca1-...` (P0 #130), Vincent telegram 5009 |
| **Date** | 2026-05-15 16:40 Beijing (UTC+8) |
| **Scope** | code-path trace across the 3 layers that handle tool calling — **complementary to** SDK马's curl A/B + hotfix validation in [`docs/research/intern-tool-calling-investigation.md`](./intern-tool-calling-investigation.md) (which has the on-the-wire phase A/B evidence; not duplicated here) |
| **Verdict** | Hotfix is in the right place; detection signal is reasonable but narrow; documents the 3 vendor-aware gaps the hotfix doesn't cover |

## 0. Why a code trace (and not another curl run)

SDK马's investigation already proved the root cause via direct `curl` against `chat.intern-ai.org.cn/v1/messages`:

> intern-s2-preview's API accepts the `tools` parameter without erroring, but the underlying model has not been trained / instruction-tuned to emit `tool_use` content blocks under the default `tool_choice:"auto"` setting.

…and demonstrated the bias-prompt hotfix flipping `stop_reason: max_tokens` → `tool_use`.

This report fills the **other half**: which file:line in our codebase carries that tools spec from `anet node create` all the way to the wire, and where vendor-specific behaviour can/does hook in. That tells us:

- Whether the hotfix sits in the right layer (yes, see §2.2)
- Whether the hotfix's detection signal is robust (3 gaps, see §5)
- Whether other vendors could silently regress the same way (yes, plausibly — see §5)

## 1. Layer 1 — `agent-network` is vendor-agnostic at the tool layer

`agent-network/bin/cli.ts` constructs the node config and hands off to `agent-node` via `spawn`. It does **not** construct any tool spec.

| File | Line | What |
|---|---|---|
| `agent-network/bin/cli.ts` | 1315–1376 | `VENDORS` table — single source of truth for vendor → `runtime`/`baseUrl`/`envKey`/`models` |
| `agent-network/bin/cli.ts` | 1320 | intern entry: `baseUrl: "https://chat.intern-ai.org.cn"`, `runtime: "claude-agent-sdk"`, `envKey: "ANTHROPIC_AUTH_TOKEN"` |
| `agent-network/bin/cli.ts` | 1395–1416 | `selectVendorAndModel()` — vendor picker writes the model + base URL + envKey into the node config |
| `agent-network/bin/cli.ts` | 2028–2057 | `launchAgent` `claude-agent-sdk` branch — spawns `agent-node` with `--config` / `--alias` / `--runtime` and the resolved env (incl. `ANTHROPIC_BASE_URL`) |

**Critical observation**: the `VENDORS` entry for intern has the same shape as `minimax` / `mimo` / `anthropic` / `custom`. There is **no vendor capability field** (e.g. `needsToolUseBias`, `toolsParameterSupported`, `defaultToolChoice`). agent-network treats every `claude-agent-sdk` vendor as interchangeable at the tool-spec layer.

→ All vendor-aware tool logic, if any exists, lives in `agent-node` or below.

## 2. Layer 2 — `agent-node` builds the SDK options + applies the hotfix

`agent-node/src/cli.ts` reads the node config, constructs `options.tools` for the SDK, and applies the intern bias prompt.

### 2.1 Tools spec construction

| File | Line | What |
|---|---|---|
| `agent-node/src/cli.ts` | 210 | `const TOOLS_PRESET = { type: "preset" as const, preset: "claude_code" as const }` — the SDK preset sentinel |
| `agent-node/src/cli.ts` | 211 | `ALL_TOOLS` — historical hardcoded list (kept for compatibility) |
| `agent-node/src/cli.ts` | 212–221 | `TOOLS` resolution: `--tools all` → preset / explicit allowlist → `string[]` / unset (`""`) → preset (the #101 fix) |
| `agent-node/src/cli.ts` | 652–653 | `options.tools: TOOLS` — handed to `query({ prompt, options })` |
| `agent-node/src/cli.ts` | 705 | `for await (const message of query({ prompt, options }))` — the SDK call |

**Important**: there is **no vendor branch** here. Regardless of whether the vendor is intern, MiniMax, MiMo, or Anthropic, the same `TOOLS` value is passed to the SDK.

### 2.2 The #130 hotfix — intern-specific system-prompt bias

| File | Line | What |
|---|---|---|
| `agent-node/src/cli.ts` | 674–686 | `// #130 hotfix` block; bias prompt + detection regex |
| `agent-node/src/cli.ts` | 683 | Detection: `/intern-ai\.org\.cn\|chat\.intern-ai/i.test(process.env.ANTHROPIC_BASE_URL \|\| "")` |
| `agent-node/src/cli.ts` | 684–686 | Bias prompt: `"When a tool is available and applicable to the user request, you MUST respond by emitting a tool_use content block, not by writing text…"` |
| `agent-node/src/cli.ts` | 687 | `const combinedSystemPrompt = internToolUseBias + (SYSTEM_PROMPT || "")` — bias prepended; user's system prompt preserved |
| `agent-node/src/cli.ts` | 688 | `if (combinedSystemPrompt) options.systemPrompt = combinedSystemPrompt` |

The hotfix sits in the **only** layer with both (a) the runtime context (env var visible) and (b) write access to `options.systemPrompt` before the SDK call. Right place.

## 3. Layer 3 — `claude-agent-sdk` preset abstraction

The SDK is a thin JS wrapper that spawns the bundled `claude` binary as a subprocess. The preset sentinel is documented at the SDK type level but expands inside the binary, not in the JS bundle.

| File | Line | What |
|---|---|---|
| `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` | 1233–1238 | `tools?: string[] \| { type: 'preset'; preset: 'claude_code' }` — public type. Doc: *"Use all default Claude Code tools"* |
| `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` | 1722–1778 | `systemPrompt?: string \| { type: 'preset'; preset: 'claude_code'; append?: string; excludeDynamicSections?: boolean }` |
| `agent-node/src/cli.ts` | 465, 624–662 | `claudePath` resolution: `@anthropic-ai/claude-agent-sdk-linux-x64/claude` (the bundled binary). Passed via `options.pathToClaudeCodeExecutable` |
| `node_modules/.../sdk.mjs` | (minified) | `M7` toolRunner / agent bridge — spawns the binary, pipes JSON over stdio |

**On-the-wire shape**: by the time the binary sends a request to `${ANTHROPIC_BASE_URL}/v1/messages`, the preset has been expanded into a **standard Anthropic-spec `tools: [...]` array**. Intern, MiniMax, MiMo, Anthropic — they all see the same wire format for the same `TOOLS_PRESET` input.

→ The intern problem is **not** a wire-format incompatibility. It's a model-side training gap. SDK马's curl A/B confirms this: identical request shape, only the model differs.

## 4. End-to-end summary

```
anet node create <alias> --runtime claude-agent-sdk --baseUrl https://chat.intern-ai.org.cn
  ↓ cli.ts:1395 selectVendorAndModel → writes config.json
  ↓ cli.ts:2028 launchAgent → spawn("agent-node", {--config, --alias, --runtime})
                              env: ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN
       └─→ agent-node CLI
             ↓ cli.ts:210 TOOLS_PRESET = { type: 'preset', preset: 'claude_code' }
             ↓ cli.ts:212–221 TOOLS resolution (no vendor branch)
             ↓ cli.ts:674–688 #130 HOTFIX — if (ANTHROPIC_BASE_URL matches intern) prepend bias prompt
             ↓ cli.ts:653 options.tools = TOOLS
             ↓ cli.ts:688 options.systemPrompt = combinedSystemPrompt
             ↓ cli.ts:705 query({ prompt, options }) — claude-agent-sdk
                  └─→ spawn(claude binary, --stdin-json) — expands preset → tool list
                        └─→ POST ${ANTHROPIC_BASE_URL}/v1/messages
                              tools: [<Anthropic-spec list>]
                              tool_choice: "auto"
                              system: <combinedSystemPrompt with bias>
                              ↓
                              intern-s2-preview responds with tool_use block ✓
```

## 5. Hard-coded assumptions / vendor-aware gaps

The hotfix works for the immediate symptom. Three gaps worth surfacing for follow-up:

### 5.1 Detection is URL-regex only

```ts
const isInternEndpoint = /intern-ai\.org\.cn|chat\.intern-ai/i.test(process.env.ANTHROPIC_BASE_URL || "");
```

Fails-open for:
- A user running an intern proxy / local mirror under a custom domain (e.g. company-internal `llm.example.com → intern-s2`)
- An OpenRouter-style aggregator routing to intern under its own URL
- A future intern endpoint at a different domain (e.g. `intern-s3.example.com`)

**Recommendation**: add model-name as a secondary signal. `MODEL` is set at `agent-node/src/cli.ts:201`; an additional regex like `/^intern-s\d/i.test(MODEL)` would catch the proxy + aggregator cases.

### 5.2 The bias is silently injected

The hotfix prepends to `systemPrompt` and logs nothing. Users who set a custom `systemPrompt` may be confused why their prompt is shorter than expected at the top.

**Recommendation**: log a single line when the bias fires, e.g.

```ts
if (isInternEndpoint) log(`[claude] intern endpoint detected — prepending tool_use bias prompt (#130 hotfix)`);
```

Visibility cost = 1 log line; debug value = high.

### 5.3 Vendor capability not modelled at the table layer

Layer 1's `VENDORS` table (cli.ts:1315–1376) is the natural place to declare "this vendor needs a tool_use bias prompt" — but currently has no capability field. The hotfix lives 1 layer down in agent-node and is opaque to the cli surface.

**Recommendation** (post-hotfix follow-up): promote the detection to a vendor capability field:

```ts
interface Vendor {
  ...
  needsToolUseBias?: boolean;   // new
  toolChoiceQuirk?: "auto-rambles" | "respects-tool-use"; // future
}

// intern entry
{ key: "intern", ..., needsToolUseBias: true }
```

Then thread the flag into the node config so agent-node reads it explicitly rather than re-detecting from URL. Same wiring as `--runtime`/`--model`/`--tools`.

This makes the vendor's quirk **declared and visible** at the layer where the user picks the vendor, instead of buried in a runtime regex.

### 5.4 Other vendors not covered

The hotfix only covers intern. If MiMo, DeepSeek-via-custom, or any other Anthropic-compatible vendor has the same model-side gap, agent-node will silently produce the same "Thinking Process" verbosity that broke intern.

**Recommendation**: add a quick smoke test to `anet doctor` (or a new `anet vendor-check <vendor>`) that posts the minimal `commhub_send_task` tool-use prompt and asserts `stop_reason: "tool_use"`. Run it once after `anet node create` to catch the regression class proactively.

## 6. Concrete code references

For grep/audit convenience:

```
agent-network/bin/cli.ts:1320   VENDORS["intern"] entry
agent-network/bin/cli.ts:1395   selectVendorAndModel hand-off
agent-network/bin/cli.ts:2028   launchAgent claude-agent-sdk branch
agent-node/src/cli.ts:210       TOOLS_PRESET sentinel
agent-node/src/cli.ts:212–221   TOOLS resolution
agent-node/src/cli.ts:652–653   options.tools = TOOLS
agent-node/src/cli.ts:674–688   #130 hotfix
agent-node/src/cli.ts:705       claude-agent-sdk query() invocation
node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1233–1238   ToolsField preset type
```

## 7. Cross-references

- SDK马's curl A/B + hotfix validation: [`docs/research/intern-tool-calling-investigation.md`](./intern-tool-calling-investigation.md)
- The #101 root-cause fix that ships with the TOOLS_PRESET sentinel: [issue #101](https://github.com/sleep2agi/agent-network/issues/101)
- The #130 hotfix scope: [issue #130](https://github.com/sleep2agi/agent-network/issues/130)
- The vendor table source of truth is Vincent's verify-with-a-real-call SOP: **do not hardcode a vendor's
  capability table from its docs — issue one real call and record what came back.**
