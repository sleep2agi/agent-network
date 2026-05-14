# SDK Deep-dive: claude-agent-sdk vs codex-sdk

> For contributors who want to plug in a new SDK or understand how anet wraps existing ones.
> If you're just trying to pick one to use, read [Node Runtime](/en/guide/runtimes) instead.

anet ships three runtimes today. Two are SDK adapters (the third, `claude-code-cli`, spawns the local `claude` binary and is out of scope here):

- `claude-agent-sdk` — official `@anthropic-ai/claude-agent-sdk`, listed in [`@sleep2agi/agent-node`'s regular `dependencies`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/package.json) (not baked into the dist — the build flag is `--external` — but npm resolves it as a sub-dependency at install time)
- `codex-sdk` — official `@openai/codex-sdk`, listed as an **optional peerDependency** (npm 7+ pulls it in by default; if it's missing, run `npm install -g @openai/codex-sdk` plus install the `@openai/codex` binary globally)

The two SDKs differ substantially across API entry, session semantics, tool registration, streaming, token accounting and error handling. The anet wrapper reconciles them with two branches (`processWithClaude()` / `processWithCodex()`) plus a single `think()` scheduler. This document walks through 11 dimensions side-by-side and ends with "how to plug in a new runtime (gemini-cli / qwen-code / …) by copying the pattern."

::: tip How to read this
All `agent-node/src/cli.ts:NNN` line numbers below are calibrated against GitHub `main`. agent-node cli.ts changes often; if they drift, the named blocks (`processWithClaude` / `processWithCodex` / `writebackSession` / `think`) stay stable — search by symbol.
:::

---

## 11-dimension comparison

| Dimension | `claude-agent-sdk` | `codex-sdk` |
|---|---|---|
| **Package / version** | `@anthropic-ai/claude-agent-sdk` ^0.2.140 (regular dep — see [agent-node/package.json](https://github.com/sleep2agi/agent-network/blob/main/agent-node/package.json) for the source of truth) | `@openai/codex-sdk` >=0.130.0 (optional peerDep — same source) |
| **API entry** | `query({ prompt, options })` → `AsyncGenerator<SDKMessage>` | `new Codex({...}).startThread(opts)` / `.resumeThread(id, opts)` → `Thread`; then `Thread.run()` / `Thread.runStreamed()` |
| **Session semantics** | `SDKSystemMessage{subtype:'init'}.session_id` arrives in the first frame; resume via `Options.resume` or `Options.continue`; on-disk under `~/.claude/projects/<cwd>/<uuid>.jsonl` | `Thread.id` is only populated after the first turn starts; resume via `codex.resumeThread(id, opts)`; on-disk under `~/.codex/sessions/` |
| **Tool registration** | `tools: string[]` for built-ins + `mcpServers: Record<string, McpServerConfig>` (stdio / http / sse); subagents definable | Toolset is **not detachable** — Codex CLI's full kit (Read/Write/Edit/Bash/Grep/Glob/WebSearch) is baked in; MCP is wired through Codex CLI's global `config.toml` |
| **Streaming** | `for await (const m of query(...))` yielding typed `SDKMessage` (system / assistant / user / result / hook / status / …) | `for await (const ev of thread.runStreamed(...).events)` yielding `ThreadEvent`: thread.started / turn.started / item.started / item.updated / item.completed / turn.completed / turn.failed / error |
| **Token accounting / budget** | `SDKResultMessage` carries `usage.input_tokens / output_tokens`, `total_cost_usd`, `num_turns`; `maxTurns` enforces a cap | `TurnCompletedEvent.usage{input_tokens, cached_input_tokens, output_tokens}`; **no** `num_turns` (one turn per `runStreamed` call); **no** official cost field — derive it from a model→price table yourself |
| **Error handling + retry** | Throws `AbortError` (cancellation) or generic Error; `result.subtype !== "success"` carries an `error` field | `TurnFailedEvent{error}` or `ThreadErrorEvent{message}`; once a thread enters a bad state the anet wrapper rebuilds **the entire thread** (catch branch re-`startThread` + single `run`) |
| **Multi-turn / history** | SDK manages conversation history internally; `Options.maxTurns` enforces a cap; overflow yields `result.subtype="error_max_turns"` | Thread persists history to `~/.codex/sessions/`; `model_auto_compact_token_limit` (anet sets 200000) lets the Codex CLI auto-compact; no "turn cap" concept |
| **BASE_URL equivalent** | `ANTHROPIC_BASE_URL` env (read by claude-agent-sdk internally) + `ANTHROPIC_AUTH_TOKEN`, routable to MiniMax / DeepSeek / GLM / Kimi / InternLM Anthropic-compatible endpoints | `Codex({baseUrl, apiKey})` constructor + `OPENAI_API_KEY` env; could point at any Codex-compatible provider in principle, but anet doesn't surface this yet — stays on OpenAI direct or `codex auth login` (ChatGPT subscription) |
| **settingSources / isolation** | `Options.settingSources: SettingSource[]` selects which layers (`['user','project','local']`) to load; anet hard-codes `[]` to fully ignore the host's `~/.claude/` | `CodexOptions.env: Record<string,string>` — once set, the SDK does **not** inherit `process.env`; `CodexOptions.config` equivalent to `codex --config key=value`; anet currently inherits `process.env` (no strict isolation yet) |
| **Breaking-change cadence** | Frequent minors (0.x); Anthropic actively pushes the SDK roadmap, API surface still moves fast | Still 0.x; `ThreadEvent` schema occasionally gains new item types; `Codex` constructor stable; CLI binary upgrades on `@openai/codex` cadence |
| **anet wrapper code anchors** | `agent-node/src/cli.ts` — `processWithClaude()` ~L373, main loop L546, session writeback L551 → [`writebackSession()`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) L202 | `agent-node/src/cli.ts` — `processWithCodex()` ~L606, streaming loop L655, session writeback L673 |

---

## Per-SDK integration notes

### claude-agent-sdk

**Strengths**
- Both the built-in toolset and MCP registration are **structured fields**, so injecting commhub MCP is a clean push onto `options.mcpServers` (cli.ts L479-484).
- Streaming is a typed `AsyncGenerator<SDKMessage>` — `for await` destructures cleanly per message subtype.
- `SDKResultMessage.total_cost_usd` is built-in, no need to compute USD cost yourself.
- Host-side `~/.claude/` can be fully ignored via `settingSources: []` — critical for multi-tenant / multi-node coexistence.

**Pitfalls**
- **Linux glibc binary**: the SDK installs the musl variant (`@anthropic-ai/claude-agent-sdk-linux-x64-musl`) by default, which fails on glibc-based Debian/Ubuntu/RHEL with `Claude Code native binary not found`. anet bridges this at [cli.ts L391-408](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) with an on-the-fly `npm install --no-save @anthropic-ai/claude-agent-sdk-linux-x64` (glibc package).
- **Root-user `dangerouslySkipPermissions` ban**: Claude Code refuses the skip-permissions flag when running as root (security policy), and without it every tool call hangs on human approval. The wrapper detects root early at [cli.ts L423](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) and tells the user to switch to a non-root user or to `codex-sdk`.
- **MCP `type` must be `http` / `sse` / `stdio`**: the SDK schema is strict — an older `type: "url"` accepted by the legacy CLI is rejected here (see comment block at cli.ts L474-484).
- **maxTurns default**: SDK has no default; anet pins `MAX_TURNS=50` (cli.ts L161). The original default of 5 burned through on one commhub MCP call.

**Session writeback mechanic**

```ts
// cli.ts:573-580
for await (const message of query({ prompt, options })) {
  const m = message as any;
  if (m.type === "system" && m.subtype === "init") {
    claudeSessionId = m.session_id;                    // capture session id
    writebackSession(m.session_id);                    // persist to config.json
  }
  // ...
}
```

On the next call to `processWithClaude()`, the module-level `claudeSessionId` is reused as `options.resume = claudeSessionId` (L541), and the Anthropic backend continues the same session. `writebackSession()` (L202-213) stamps the id into `.anet/nodes/<alias>/config.json` under `session`, so a process restart still resumes.

### codex-sdk

**Strengths**
- Cleaner thread abstraction: `thread.run(input)` returns `Turn{items, finalResponse, usage}` — the per-turn shape is immediately obvious.
- `runStreamed`'s `ThreadEvent` schema is a discriminated union — destructures wonderfully in TypeScript.
- Toolset "just works" — no need to maintain an allowlist in the wrapper (the flip side: you can't strip tools either).
- `Codex({config: {model_auto_compact_token_limit: 200000}})` auto-compacts long-running threads; the wrapper doesn't need to truncate history manually.

**Pitfalls**
- **Requires the global `codex` binary**: the peerDependency is optional, so users must `npm install -g @openai/codex` to run; the wrapper raises an explicit `@openai/codex-sdk not installed` error when missing (cli.ts L620-622).
- **PATH injection**: the wrapper does `which codex` first and prepends its directory to `process.env.PATH` at [cli.ts L608-615](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) to keep subprocess spawns reliable.
- **Bad threads rebuild from scratch**: a single failed turn drops into a catch branch that re-`startThread()` and runs once more (cli.ts L678-690) — i.e. the original thread's history is **lost** on the failure path.
- **Token cost is DIY**: `usage` only reports token counts, not USD. To enforce a budget you need a model→price table; anet currently has **no** `maxBudgetUsd` enforcement on the codex branch.
- **gpt-5.4 is the default**: hard-coded at three call sites (cli.ts L689 / L705 / L746). Third-party Codex-compatible providers (e.g. MiniMax) are in the RFC backlog but not wired yet.

**Session writeback mechanic**

```ts
// cli.ts:689-710
const { events } = await codexThread.runStreamed(input);
for await (const ev of events) {
  if (ev.type === "turn.completed") usage = ev.usage;
  // ...
}
if (codexThread?.id) writebackSession(codexThread.id);   // persist to config.json
```

Note: **`Thread.id` is `null` until the first turn starts**, so the wrapper writes back **after** the turn completes, unlike claude-agent-sdk where the id arrives in the `system/init` frame. On a subsequent process start, the wrapper reads `session` from `config.json` and calls `codex.resumeThread(SESSION_ID, opts)` (cli.ts L634-636) to continue.

---

## How the anet wrapper converges the two

The architecture in `agent-node/src/cli.ts` boils down to "two SDKs, one scheduler":

```
                   inbox / SSE / Telegram inbound task
                              ↓
                          think()  ← cli.ts:822
                              ↓
                  ┌───────────┼───────────┐
                  ↓           ↓           ↓
       processWithClaude  processWithCodex  processWithHttpApi
         (cli.ts:389)      (cli.ts:644)     (cli.ts:736)
                  ↓           ↓
            SDK query()  thread.runStreamed()
                  ↓           ↓
            writebackSession(session_id) ← shared cli.ts:218
                  ↓
                config.json persisted
                  ↓
            sendReply back to commhub
```

Key convergence points:

1. **Unified scheduling.** `think()` is a `Promise` queue (cli.ts L782-803) — at most one LLM call per node at any moment, which prevents concurrent commhub MCP / filesystem interleavings.
2. **Unified session writeback.** Both SDKs route their session/thread id through [`writebackSession()`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) into the same `.anet/nodes/<alias>/config.json` field `session`. The semantics differ per runtime (Claude → jsonl UUID, Codex → thread id), but the read/write code is shared.
3. **Unified task-context injection.** Before dispatching, `think()` writes `taskId` into `process.env.CURRENT_TASK_ID` (L790-797); both SDK prompts reference this env so the LLM tags `parent_task_id` on `send_task` to chain replies back upstream.
4. **Unified error degradation.** `processTask()` (cli.ts L805-829) post-scans the `text` with a regex (L826-828) for common API-error markers (`"may not have access"`, `"model not found"`, `"API error"`, …) so "SDK didn't throw but the message is an error" still surfaces as a real failure in the Dashboard instead of a fake success.
5. **Unified commhub MCP injection.** claude-agent-sdk uses `options.mcpServers["commhub"] = { type:"http", url, headers }` (cli.ts L479-484); codex-sdk relies on the user pre-configuring Codex CLI's global `~/.codex/config.toml` — the wrapper doesn't touch it. **This is the most asymmetric piece today**; an RFC is open for a unified "wrapper-injected" approach.

---

## Adding a new Runtime (e.g. gemini-cli / qwen-code)

If the upstream SDK provides:
- TypeScript types + an ESM entry,
- An API surface that exposes a session/thread id,
- A streaming interface (AsyncGenerator or EventEmitter),

then plugging it in is roughly 5 steps, modeled on the `processWithCodex()` branch:

### Step 1: register the runtime name + map

```ts
// near cli.ts:151-158
const RUNTIME_MAP: Record<string, string> = {
  "claude-agent-sdk": "claude", /* ... */
  "codex-sdk": "codex",
  "gemini-cli": "gemini",    // ← new
};
const RUNTIME = (RUNTIME_MAP[rawRuntime] || "claude") as "claude" | "codex" | "http" | "gemini";
```

### Step 2: implement processWithGemini()

Skeleton modeled on `processWithCodex()` (cli.ts L606-692):

```ts
let geminiSession: any = null;

async function processWithGemini(task: string, from: string): Promise<string> {
  let GeminiSDK: any;
  try { ({ Gemini: GeminiSDK } = await import("@google/gemini-sdk")); }
  catch { throw new Error("@google/gemini-sdk not installed"); }

  if (!geminiSession) {
    const sdk = new GeminiSDK({ apiKey: process.env.GEMINI_API_KEY });
    geminiSession = SESSION_ID
      ? sdk.resumeSession(SESSION_ID, { model: MODEL })
      : sdk.startSession({ model: MODEL });
  }

  const t0 = Date.now();
  const stream = await geminiSession.runStreamed(task);
  let finalText = "";
  for await (const ev of stream.events) {
    if (ev.type === "message.completed") finalText = ev.text || "";
    // parse other event types — log/debug as needed
  }
  if (geminiSession?.id) writebackSession(geminiSession.id);
  log(`[gemini] done | ${Date.now() - t0}ms`);
  return finalText || "(no reply)";
}
```

### Step 3: think() branch

```ts
// near cli.ts:831
if (RUNTIME === "gemini") return await processWithGemini(task, from);
```

### Step 4: peerDependency

In `agent-node/package.json`, mark the new SDK as an optional peerDep under `peerDependenciesMeta` (follow the codex-sdk pattern) so a plain `npm install` doesn't drag it in.

### Step 5: docs

- Add the new runtime to `docs-site/docs/guide/runtimes.md` (ZH + EN) — the user-facing how-to.
- Append a column to the 11-dimension table in this document — the contributor-facing diff sheet.

::: tip On commhub MCP injection
A first cut can **skip commhub MCP injection** — the node will only "receive tasks" and can't "dispatch" them. Once the basic flow is healthy, layer in MCP injection by mirroring claude-agent-sdk's `mcpServers` field or codex-sdk's `~/.codex/config.toml` approach.
:::

---

## Further reading

- [Node Runtime](/en/guide/runtimes) — user-facing how-to + cheat sheet
- [Agent Node config](/en/guide/agent-node) — full `config.json` field reference
- [Multi-model config](/en/guide/multi-model) — verified ANTHROPIC_BASE_URL endpoints per provider
- [GitHub: agent-node/src/cli.ts](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) — source file every line-number anchor in this document refers to
