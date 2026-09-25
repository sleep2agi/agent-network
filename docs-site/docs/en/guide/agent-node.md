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

From a terminal this attaches to tmux; detach with `Ctrl-B D`. Without a TTY it starts detached. See [Fresh server · persistence](/en/deploy/clean-server#_8-persistence-systemd-tmux) for long-running and boot-time management.

## Choose a runtime

Do not select a runtime here from an old version number or fixed count. Availability follows the npm release channel:

- Claude Code, Claude Agent SDK, Codex SDK, Grok ACP, and other current paths are listed in [Runtimes](/en/guide/runtimes).
- Codex TUI co-presence is a preview feature and must use the complete `--copresence` start and recovery flow. See [Codex TUI co-presence](/en/guide/codex-copresence).
- OpenCode is currently a task runtime, not a shared TUI.
- The shared Grok TUI has not shipped. The available `grok-build-acp` runtime cannot attach; see [Grok nodes](/en/guide/grok).

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

See [tokens and permissions](/en/guide/account-system#tokens) and the [security model](/en/concepts/security) for the full boundary.

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

A `codex-app-server` node runs one turn at a time; later tasks wait in a queue. A task that has not started after 30 minutes fails with "在队列中等待 N 分钟仍未开始" (waited N minutes in the queue without starting). To change that limit, set `ANET_QUEUE_TIMEOUT_MS` (whole milliseconds, for example `21600000` for 6 hours) in the environment the node starts with. Invalid values are ignored with one warning in the node log.

At startup the node resumes the thread it is bound to before it takes any task. For a very large thread (a rollout of hundreds of MB) that can take tens of seconds. Each resume attempt waits up to 120 seconds and is retried once on timeout; if it still fails, the node reports itself offline to the hub and exits. It never falls back to a new thread, which would drop the conversation history. To change the limit, set `ANET_CODEX_RESUME_TIMEOUT_MS` (whole milliseconds, same rules as above).

An `opencode` node waits up to 30 minutes per task by default. In copresence mode (`opencodeMode: "copresence"`) this is the total time for the task. When it runs out, the bridge stops waiting, but it does not abort the turn in the shared session. The task keeps running to completion in the node's TUI, and the sender's reply says so, but the final result is not sent back later. In headless mode the limit is how long the turn may go without producing any output; when it runs out, the opencode child process is stopped and the turn is aborted. To change the limit, set the `OPENCODE_TIMEOUT_MS` environment variable, or set `flags.timeout` / `flags.opencodeTimeoutMs` in the node's `config.json` (whole milliseconds; `0` = no limit). The environment variable wins, then `flags.timeout`, then `flags.opencodeTimeoutMs`. At startup the node logs a line `[opencode] task timeout=… source=…` with the value in effect and where it came from.

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

Dashboard `/goal` and `/loop` pass unchanged to the target runtime/TUI. Use `/aloop` for ANet recurring work (`/agoal` is an equivalent namespaced entry point; both require an interval). Old `/goal` and `/loop` remain temporarily compatible outside Dashboard and return a migration notice. State lives in the node's `goals.json`. The scheduler is not a precision cron service and every wake consumes real model quota.

See [Goals and Loops](/en/guide/goals-and-loops) for routing differences, accepted schedules, wake and stop rules, self-management tools, restart limitations, and troubleshooting.

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
