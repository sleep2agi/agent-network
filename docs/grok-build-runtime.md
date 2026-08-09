# Grok Build ACP Runtime

Date: 2026-05-26

`grok-build-acp` is the Agent Network runtime for Grok Build. It launches the local `grok agent stdio` process and speaks Agent Client Protocol (ACP) over newline-delimited JSON-RPC.

The goal of the engineering preview is stable Agent Network membership:

- create a node with `anet node create ... --runtime grok-build-acp`
- start it with `anet node start ...`
- receive CommHub tasks over SSE
- run Grok Build for each task
- reply through CommHub
- persist and resume `grokSession`
- support deterministic explicit delegation to another Agent Network alias

## Requirements

- Linux, macOS, or WSL
- Node.js and Bun per the normal Agent Network requirements
- Grok Build CLI installed and authenticated

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok
```

The xAI Build documentation describes Grok Build as usable through an interactive TUI, headless scripts, or ACP integrations. It also documents `grok inspect` for checking discovered config, skills, plugins, hooks, and MCP servers.

References:

- https://docs.x.ai/build/overview

## Quick Start

```bash
anet hub start
anet login --hub http://127.0.0.1:9200 --username admin --password anethub
anet node create grok-demo --runtime grok-build-acp
anet node start grok-demo
```

Expected startup markers:

```text
runtime: grok-build-acp
model:   configured by Grok CLI
SSE connected
```

When no `--model` is supplied, Agent Network does not pass a model id to the
ACP child. Grok selects the model from its own configuration/default. The
runtime name `grok-build-acp` (and its legacy alias `grok-build`) is not a
model id.

Send a REST task（三个变量都从登录后的 `~/.anet/config.json` 取——`anet login` 会写入；缺 `network_id` 请求会被拒）:

```bash
COMMHUB_URL=$(jq -r .hub ~/.anet/config.json)
ANET_TOKEN=$(jq -r .token ~/.anet/config.json)
NETWORK_ID=$(jq -r .network_id ~/.anet/config.json)

curl -sS -X POST "$COMMHUB_URL/api/task" \
  -H "Authorization: Bearer $ANET_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"alias":"grok-demo","task":"Reply with exactly GROK_RUNTIME_OK.","from":"api","priority":"high","network_id":"'"$NETWORK_ID"'"}'
```

Expected result in `/api/tasks`:

```text
status: replied
result: [grok-demo] GROK_RUNTIME_OK
```

Expected node config after first turn:

```json
{
  "runtime": "grok-build-acp",
  "grokSession": "019e..."
}
```

## Known Limits

`grok-build-acp` is stabilizing. The behaviors below are tracked under [#189](https://github.com/sleep2agi/agent-network/issues/189) — set expectations before depending on the runtime for production traffic.

### Intermittent ACP error `-32603` (R1)

Some general-purpose turns sporadically return `-32603: Internal error` from the Grok ACP server. `agent-node` does not retry these; the task replies with the raw error text. The reproducer is unstable and the root cause is on the Grok server side, still under confirmation.

**Workaround**: Resend the task, or route it to a `claude-agent-sdk` / `codex-sdk` node. Detailed remediation: see [Troubleshooting → `grok ACP error -32603`](#grok-acp-error--32603-internal-error) below.

### MCP readiness race (R2)

On a fresh `grokSession`, the first turn may surface a "CommHub MCP servers are still connecting" notice. `agent-node` strips those leakage lines via the `sanitizeGrokCommhubLeak` filter, but the user-visible reply text may still be incomplete.

**Workaround**: After `anet node start`, wait 5–10 seconds for the MCP handshake to complete before sending substantive tasks. Detailed remediation: see [Troubleshooting → Grok says MCP servers are still connecting](#grok-says-mcp-servers-are-still-connecting) below.

### Stale `.anet/node-server.js` drift (R3)

> **`.mcp.json` shared-identity issue — RESOLVED in v0.10.11 latest ([#204](https://github.com/sleep2agi/agent-network/issues/204))**
>
> Earlier versions had a separate failure mode where a stale `.mcp.json` left in the project directory (written by an older `anet` setup flow with a different alias) would be picked up by Grok as a fallback, attaching the **wrong CommHub alias** to outbound `send_task` calls. **Fixed across the preview.2 → preview.7 chain promoted as `agent-node@2.4.7`** (v0.10.11 latest, root-cause commit [`4b5a657`](https://github.com/sleep2agi/agent-network/commit/4b5a657)):
>
> - **preview.2** ([`4b5a657`](https://github.com/sleep2agi/agent-network/commit/4b5a657)): `grok-build-acp` passes `mcpServers` explicitly on every `session/new` / `session/load` so Grok never falls back to reading cwd `.mcp.json` via the ACP path — structurally fixes the shared-identity bug on the ACP side
> - **preview.6** ([`abefbe8`](https://github.com/sleep2agi/agent-network/commit/abefbe8)): transport switched from **stdio** (spawning `.anet/node-server.js`) to **HTTP** (Grok calls commhub `/mcp` directly with `Authorization: Bearer <ntok_>` header). Grok ACP `init` response reports `mcpCapabilities = {http: true, sse: true}` so HTTP transport is the canonical path; commhub-server already derives `from_session` from the bearer ntok (`server/src/index.ts:446-448`, [`d1d867e`](https://github.com/sleep2agi/agent-network/commit/d1d867e) hub-side bind from #194). Bypasses subprocess, bun PATH, framing, and stdout-pollution risk entirely.
> - **preview.7** ([`72e28fd`](https://github.com/sleep2agi/agent-network/commit/72e28fd)): **per-node isolated cwd** to defeat stale `.mcp.json` discovery. UAT after preview.6 still showed the wrong `from=` alias on the receiver — root cause: Grok CLI auto-reads cwd `.mcp.json` **alongside** the ACP `session/new` mcpServers injection, so two commhub MCP servers coexist and the stale stdio one wins the LLM's hello message. preview.7 fix: pass per-node isolated dir `<home>/.anet/nodes/<node-id>/grok-cwd/` via ACP `session/new`'s existing `cwd` field. Per-node dir mirrors top-level user files via symlink (so LLM `Read('./README.md')` still works) but **skips `.mcp.json`** so cwd discovery finds nothing. Multi-node concurrent-spawn safe by construction; fallback to user cwd on mkdir/readdir failure (preview.6 behavior, no regression).
>
> **v0.10.11 is now `@latest`** — all `@latest` users automatically have the per-node isolated cwd fix. Users still on v0.10.10 (`agent-node@2.4.6`) or earlier will see the legacy stdio behavior with shared-cwd risk; run `anet upgrade` or `npm i -g @sleep2agi/agent-network@latest` to pick up the fix, or manually delete any stale `.mcp.json` in the cwd before starting a `grok-build-acp` node.

If the project directory carries an older `.anet/node-server.js`, **legacy `grok-build-acp` nodes** (v0.10.10 and earlier, `agent-node@2.4.6` or older) may receive a stale CommHub tool schema that is missing `get_task` / `parent_task_id` — explicit delegation chains will silently break. (This is independent of the `.mcp.json` issue above. v0.10.11 preview.6 attempted HTTP transport but preview.7 final reverted to stdio with the per-node isolated cwd fix — see the chain history in the previous note. The `.anet/node-server.js` helper script is regenerated by `agent-node` itself and is **not** affected by `#204`.)

**Workaround**: Delete the stale `.anet/node-server.js` and re-run `anet node create` so `agent-node` rewrites the latest interface.

The deletion is **scoped to the current project directory's `.anet/`** — other project workdirs (`/path/to/another-project/.anet/`) and your global `~/.anet/` config are not touched. All nodes co-located in the same project directory share that one helper file, so the rebuild affects every node in that workdir at once; `anet node create` regenerates the helper with the current sanitizer and the cost is effectively zero. Node identity and CommHub credentials persist in `~/.anet/nodes/<alias>/`, so no node loses its `node_id` or token.

### No image input (R5)

The Grok Build ACP fixture reports `promptCapabilities.image=false`. Sending a task with `attachments[].path` pointing to an image causes `agent-node` to log a warning and downgrade to a plain-text prompt.

**Workaround**: Route image-bearing tasks to a `codex-sdk` or `claude-agent-sdk` node.

### Explicit-delegation phrasing in flux (R4 — broadening in progress)

In `agent-node` v2.4.5 and earlier, the CommHub wrapper only recognizes the literal `给 X 发任务` / `给 X 派任务` / `send_task X` phrasing for explicit delegation. **Starting in v2.4.6**, recognition broadens to mixed Chinese/English shapes such as `和 / 与 / 跟 / 找 / 让 / 交给 / 转给 X 沟通一下 / 做 / 完成 / review / ship …`. When the wrapper matches, `agent-node` intercepts the turn before it reaches Grok, runs `send_task` with the proper `parent_task_id` chain, and returns the child's reply on the parent task. See the [Delegation Contract](#delegation-contract) below for the supported workflow.

## Stable Preview Contract

`grok-build-acp` is stable for the following Agent Network behavior:

- The node registers with CommHub using its normal network token.
- SSE task delivery reaches the node.
- `agent-node` reports working and idle status around each turn.
- Grok Build processes text tasks through ACP.
- `agent-node` sends the final reply to the task originator.
- `grokSession` is written back and reused.
- If a saved session returns ACP `-32603`, the runtime clears it and retries once with a fresh session.
- JSON-RPC `error.data` is included in the thrown error message when Grok provides it.

## Delegation Contract

Native Grok MCP tool injection is not the stable path in this preview.

For deterministic cross-agent delegation, use explicit wording. The `agent-node` wrapper recognizes a broad set of Chinese / English phrasings — pick whichever reads naturally:

```text
# Direct MCP-style
send_task A站助手 用一句话介绍 A站当前情况

# Verb-suffixed (most common in Chinese chat)
给 A站助手 发任务: 用一句话介绍 A站当前情况
给 A站助手 说一下 当前情况
给 A站助手 沟通一下 进度
给 A站助手 打个招呼
让 A站助手 ship 这个 PR
请 A站助手 review 一下
派给 A站助手: ...
转给 A站助手: ...
交给 A站助手: ...

# Colloquial / imperative
你去给 A站助手 打个招呼
你和 A站助手 沟通一下 ...
```

When `agent-node` detects any of these shapes, it intercepts the turn **before** it reaches Grok and handles the workflow itself:

1. `get_all_status` checks the target alias.
2. `send_task` dispatches the child task with `parent_task_id`.
3. `get_task` polls until the child reaches `replied`, `failed`, or `cancelled`.
4. The child result is returned to the original task sender.

This is the supported collaboration mode for the first preview because it avoids depending on Grok native MCP tool discovery.

> **v0.10.11 latest ([#201](https://github.com/sleep2agi/agent-network/issues/201) commit [`bd72e9f`](https://github.com/sleep2agi/agent-network/commit/bd72e9f))** — 3-layer hardening shipped in `agent-node@2.4.7`:
>
> 1. **Wrapper parser broadened** to cover `send_task X Y`, `给 X (发|说|沟通|打) [个|消息|一下|招呼…] BODY`, `你去给 X BODY`, `让/请/派给/转给/交给 X …` — typical Chinese chat phrasings that earlier preview versions missed.
> 2. **Grok system prompt softened** — if the wrapper misses an edge-case phrasing, Grok is now instructed to **fall back to calling `commhub_send_task` directly** instead of refusing the task with "无法直接执行 / 请提供精确 alias 和子任务内容". Vincent 6229 UAT catch.
> 3. **Authorised fallback list** — the prompt explicitly enumerates the wrapper-covered phrasings so Grok can recognize edge cases and degrade gracefully.
>
> On v0.10.10 and earlier (`agent-node@2.4.6` or older), only the narrower `给 X 发任务` / `给 X 派任务` / `send_task X` literal phrasings reliably trigger the wrapper; other shapes may fall through to Grok and get refused. **v0.10.11 is now `@latest`** — run `anet upgrade` or `npm i -g @sleep2agi/agent-network@latest` to pick up the 3-layer hardening.

## Operational Notes

Start Grok nodes in tmux for observability:

```bash
tmux new -s grok-demo -c "$PWD" 'anet node start grok-demo'
```

Inspect:

```bash
anet status
anet logs grok-demo
cat .anet/nodes/grok-demo/config.json | jq .grokSession
```

If the node was started outside tmux, stop the detached process and restart it inside tmux so operators can attach and inspect logs.

## Troubleshooting

### `grok CLI not found`

Install Grok Build and restart the node:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok --version
```

### `Grok ACP authenticate failed`

Run `grok` interactively once, or configure the environment expected by Grok Build. Then restart the node.

### `grok ACP error -32603: Internal error`

Use the latest preview code and restart the node. The runtime now:

- advertises only implemented ACP client capabilities
- treats stale-session `-32603` as retryable once
- includes `data=` diagnostics when Grok returns JSON-RPC error data

If it still reproduces, save:

- node log
- task id
- current `grokSession`
- any `data=` suffix in the error

Then attach those to issue #189.

### Grok says MCP servers are still connecting

That means Grok native MCP tool discovery is not the active support path. Use explicit delegation wording so `agent-node` performs the CommHub call deterministically.

## Verification

Docker E2E:

```bash
sg docker -c 'docker build -f tests/test-grok-build-acp-runtime/Dockerfile -t anet-grok-acp-runtime .'
sg docker -c 'docker run --rm -v /home/vansin/.grok:/host-grok:ro -v /home/vansin/agent-orchestra/docs/tests/p-grok-build-acp-runtime:/artifacts anet-grok-acp-runtime'
```

Expected report:

```text
PASS: agent registered
PASS: task replied
PASS: grokSession persisted
```

Live smoke:

```bash
anet node create grok-demo --runtime grok-build-acp
anet node start grok-demo
# send REST task: Reply with exactly GROK_RUNTIME_OK.
anet status
```

Issue tracker:

- https://github.com/sleep2agi/agent-network/issues/189
