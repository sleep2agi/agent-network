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
anet login --username admin --password anethub
anet node create grok-demo --runtime grok-build-acp
anet node start grok-demo
```

Expected startup markers:

```text
runtime: grok-build-acp
model:   grok-build (default)
SSE connected
```

Send a REST task:

```bash
curl -sS -X POST "$COMMHUB_URL/api/task" \
  -H "Authorization: Bearer $ANET_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"alias":"grok-demo","task":"Reply with exactly GROK_RUNTIME_OK.","from":"api","priority":"high"}'
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

### Stale `.anet/node-server.js` / `.mcp.json` drift (R3)

If the project directory carries an older `.anet/node-server.js` or `.mcp.json`, Grok may receive a stale CommHub tool schema that is missing `get_task` / `parent_task_id` — explicit delegation chains will silently break.

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

For deterministic cross-agent delegation, use explicit wording:

```text
给 A站助手 发任务: 用一句话介绍 A站当前情况
```

When `agent-node` detects that shape, it handles the workflow before invoking Grok:

1. `get_all_status` checks the target alias.
2. `send_task` dispatches the child task with `parent_task_id`.
3. `get_task` polls until the child reaches `replied`, `failed`, or `cancelled`.
4. The child result is returned to the original task sender.

This is the supported collaboration mode for the first preview because it avoids depending on Grok native MCP tool discovery.

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
