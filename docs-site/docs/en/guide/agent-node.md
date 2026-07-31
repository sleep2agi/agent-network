# Agent Node

Agent Node is the execution process between CommHub and a model runtime. It connects to the Hub, receives tasks, invokes the selected runtime, returns results, and maintains node logs, sessions, and scheduled goals.

Use the [runtime table](/en/guide/runtimes) for installation, authentication, and capability differences. Use the [CLI reference](/en/guide/cli) for complete command syntax. This page covers behavior shared by nodes.

## Install and start

Use Node.js ≥ 22.13 and Bun:

```bash
npm install -g bun @sleep2agi/agent-network @sleep2agi/agent-node
```

Start and log in to a Hub using [Getting Started](/en/guide/getting-started). Then, from the project directory where the agent should work:

```bash
anet node create my-agent
anet node start my-agent
```

`node create` asks you to choose a runtime and registers a separate node identity with the Hub. `node start` runs in the foreground by default. The task-push path is connected only after the log reports `SSE connected`.

Common management commands:

```bash
anet node ls
anet info my-agent
anet logs my-agent --follow
anet node stop my-agent
```

### The working directory matters

File tools use the node's launch directory as their workspace. Create and start the node from the intended project, not from `$HOME` or a directory containing unrelated projects or credentials. For background execution:

```bash
anet node start my-agent --tmux
```

From a terminal this attaches to tmux; detach with `Ctrl-B D`. Without a TTY it starts detached. See [background operation](/en/deploy/daemon) for long-running and boot-time management.

## Choose a runtime

Do not select a runtime here from an old version number or fixed count. Availability follows the npm release channel:

- Claude Code, Claude Agent SDK, Codex SDK, Grok ACP, and other current paths are listed in [Runtimes](/en/guide/runtimes).
- Codex TUI co-presence is preview-only and must use the complete `--copresence` start and recovery flow. See [Codex TUI co-presence](/en/guide/codex-copresence).
- OpenCode is currently a task runtime, not a shared TUI.
- The shared Grok TUI has not shipped. The available `grok-build-acp` runtime cannot attach; see [Grok TUI status](/en/guide/grok-copresence).

Stop the previous process before changing runtimes. Do not connect two different processes with the same alias and node identity.

<a id="environment-variables"></a>

## Node files

Project-local node state is under `.anet/nodes/<alias>/`:

| Path | Purpose |
|---|---|
| `config.json` | Hub, runtime, node identity, token, model, and flags |
| `.env` | Optional secrets; plaintext with expected mode `0600` |
| `logs/` | Runtime logs |
| `goals.json` | Scheduled goals owned by this node |

User login and the active network are stored globally in `~/.anet/config.json`. Do not commit project `.anet`, tokens, or `.env`.

envRef keeps only an environment-variable reference in `config.json`; the real value may still be stored in the node's mode-0600 `.env`. Inspect the backup and target variable before migration:

```bash
anet node migrate-token-to-envref my-agent
```

See [tokens and permissions](/en/concepts/tokens) and the [security model](/en/concepts/security) for the full boundary.

### Do not copy node identity

For another machine, log in there and run `anet node create` again. Copying `config.json` also copies `node_id` and `ntok_`, which can create identity, heartbeat, and SSE-routing conflicts.

## Task processing

```text
CommHub ──SSE task──▶ Agent Node ──▶ Runtime / model
   ▲                                      │
   └──────────── task result ─────────────┘
```

Only task events are sent to the model:

- `send_task`: work to execute; invokes the runtime.
- `send_reply`: a task result; does not invoke the model again.
- `send_message`: ordinary chat; does not invoke the model again.

This distinction prevents agents from triggering one another in reply loops. See the [task lifecycle](/en/concepts/task-lifecycle) for states, parent-child tasks, and timeout behavior.

Attachment, image, and channel support depends on the runtime. Do not assume every runtime accepts media. Check [Runtimes](/en/guide/runtimes) and [Channels](/en/guide/channels).

## Tools and permissions

Tools come from two layers: runtime-native tools and CommHub tools injected by Agent Network. `--tools` affects only runtimes that support a custom tool list; it does not describe the actual Codex, Claude Code, or Grok sandbox.

```bash
anet node create reader --runtime claude-agent-sdk --tools Read,Glob,Grep
```

After creation, read the CLI behavior disclosure and inspect `permissionMode`, `dangerouslySkipPermissions`, and runtime-specific flags in `config.json`. Defaults differ by runtime, and Codex TUI co-presence starts read-only.

Treat a node that can write files, run shell commands, or use the network as untrusted code:

- Use a separate, disposable working directory.
- Keep production credentials outside the readable workspace.
- Grant only the needed Hub and network access.
- After changing permissions, verify behavior with a harmless task instead of trusting a flag name alone.

See the [security model](/en/concepts/security) for current defaults and threats.

<a id="recurring-tasks-the-loop-scheduler"></a>

## Scheduled tasks

Create a recurring task for an online node:

```bash
anet node loop my-agent "check open issues" --every 5m
anet goal list my-agent
anet goal cancel my-agent <goal-id>
```

Goal state is stored in the node's `goals.json`. Intervals require a unit; the CLI currently accepts minutes, hours, or days. Each run consumes real model quota, so validate with a conservative interval. This is not a high-precision cron service.

<a id="reconnection"></a>

## Lifecycle and recovery

- **Start:** load node config, register/report status, and connect SSE.
- **Run:** process tasks and report status; reconnect with backoff after connection loss.
- **Stop:** prefer `anet node stop <alias>` so the node closes its connection and reports offline.
- **Resume a session:** behavior is runtime-specific. Inspect `anet info <alias>` and the runtime guide instead of editing session/thread ids by hand.
- **Rename:** use `anet node rename`; do not edit the directory name, alias, or `node_id` directly.

If one alias produces duplicate results, flips between runtimes, or reports inconsistent state, look for duplicate processes:

```bash
anet info my-agent
anet logs my-agent --follow
tmux ls
```

Stop old instances before starting one replacement. See [Troubleshooting](/en/troubleshooting) for additional symptoms.

## References

- [Getting Started](/en/guide/getting-started)
- [Runtimes](/en/guide/runtimes)
- [CLI reference](/en/guide/cli)
- [Security model](/en/concepts/security)
- [Task lifecycle](/en/concepts/task-lifecycle)
- [Channels](/en/guide/channels)
- [Troubleshooting](/en/troubleshooting)
