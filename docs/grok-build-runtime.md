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
