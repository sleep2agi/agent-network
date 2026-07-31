# `@sleep2agi/agent-node`

[![npm version](https://img.shields.io/npm/v/@sleep2agi/agent-node.svg)](https://www.npmjs.com/package/@sleep2agi/agent-node)
[![npm downloads](https://img.shields.io/npm/dm/@sleep2agi/agent-node.svg)](https://www.npmjs.com/package/@sleep2agi/agent-node)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/sleep2agi/agent-network/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-anet.sh-009e7e.svg)](https://anet.sh)

Agent Node is the worker process between CommHub and a model runtime. It receives tasks over SSE, invokes the configured runtime, returns results, and reports node status.

Most users should manage it through the `anet` CLI. `anet node create` writes the network-bound identity and runtime configuration; `anet node start` launches the matching Agent Node.

## Install and run

```bash
npm install -g bun @sleep2agi/agent-network @sleep2agi/agent-node

anet hub start
anet hub dashboard
anet login --hub http://127.0.0.1:9200 --username admin
anet node create my-bot
anet node start my-bot
```

The node is ready after `SSE connected` appears in its log.

For an existing profile, direct invocation is possible but normally unnecessary:

```bash
npx @sleep2agi/agent-node \
  --config .anet/nodes/<name>/config.json \
  --alias <name>
```

The config must contain a valid node token, or authentication must resolve through the documented legacy fallback. Do not pass a user token as node identity.

## Runtimes

Runtime availability follows the installed npm channel; do not infer it from a fixed version table in a README. Use the [runtime guide](https://anet.sh/guide/runtimes) as the current compatibility matrix.

| Runtime | Purpose | Availability boundary |
|---|---|---|
| `claude-code-cli` | Reuse a local Claude Code login/session | Published task runtime |
| `claude-agent-sdk` | Call Anthropic-compatible APIs | Published task runtime |
| `codex-sdk` | Run Codex-backed tasks | Published task runtime |
| `grok-build-acp` | Run Grok Build through ACP | Published task runtime; no human attach |
| `codex-app-server` | Share a Codex thread with a human TUI | Preview-only; use `anet node start <name> --copresence` |
| `opencode-cli` | Run the vetted OpenCode ACP path | Preview-only |

Neither npm `latest` nor `preview` includes a shared Grok TUI. Development branches may contain source-only experiments, but they are not an installable product path until published and listed in the [Grok TUI status page](https://anet.sh/guide/grok-copresence).

## Configuration and security

Project-local profiles live under `.anet/nodes/<alias>/`. A profile includes the Hub URL, runtime, `node_id`, network-bound `ntok_`, model settings, and runtime flags. Treat it as a secret:

- Do not commit `.anet`, profile files, `.env`, or tokens.
- Do not copy one node profile to another machine or alias.
- Create a separate node identity on each machine.
- Start from the intended project directory; runtime file tools inherit that workspace.
- Runtime permission defaults differ. Read the CLI disclosure and [security guide](https://anet.sh/concepts/security) before allowing shell, file-write, or network access.

Agent Node does not read environment variables literally named `TOOLS` or `SYSTEM_PROMPT`. Use `--tools` / config `tools` and `--prompt` / config `systemPrompt`.

## Task behavior

- `send_task` creates executable work and can invoke the target runtime.
- `send_reply` completes a task without invoking another model.
- `send_message` is ordinary chat and does not invoke another model.

This distinction prevents reply loops. See the [task lifecycle](https://anet.sh/concepts/task-lifecycle) for state, retry, timeout, and parent-child semantics.

## Documentation

- [Agent Node guide](https://anet.sh/guide/agent-node)
- [Runtime guide](https://anet.sh/guide/runtimes)
- [CLI reference](https://anet.sh/guide/cli)
- [Troubleshooting](https://anet.sh/troubleshooting)
- [Source repository](https://github.com/sleep2agi/agent-network)

Apache-2.0.
