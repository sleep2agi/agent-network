# Creating nodes on a remote daemon: Claude Code CLI login state is not portable

> When you pick a remote host (a host_supervisor daemon) in the dashboard to create a node, some work and some fail to start. Usually this is not a bug — the agent's **auth method decides whether it can cross machines**.

## Two auth methods, two fates

An anet node needs vendor auth to run. There are two paths, and they behave very differently across machines:

| Auth method | Stored where | Portable across hosts |
|-------------|--------------|-----------------------|
| **API key** (DeepSeek / MiniMax / Anthropic API key, etc.) | node config + hub secret vault | ✅ travels with the node, works on any host |
| **Claude Code CLI subscription login** (`claude login` OAuth) | that machine's `~/.claude` | ❌ machine-bound, not in config, not shipped to remote |

- API-key nodes → run on any daemon (the key travels with config / vault). This is exactly what the dashboard "provider preset store" solves.
- claude-code-cli subscription-login nodes → only run on a host that has already run `claude login`. A remote daemon with no login state → the node won't start.

## Symptoms

- Node creation works locally; the same node on a remote daemon won't start / is unresponsive.
- The node uses the `claude-code-cli` runtime with subscription login (not an API key).

## What to do

1. **Prefer the API-key route for multi-host / remote setups**: configure vendor + model + key in the dashboard provider store (the key goes write-only into the vault and travels with the node), then select that preset when creating the node. Zero friction across hosts.
2. **If you must use claude-code-cli subscription login**: SSH into that remote host and run `claude login` once there, so the login state lands in that machine's `~/.claude`. Only then can claude-code-cli nodes run on that host.
3. Login state is a sensitive credential and Claude CLI is designed to be machine-bound; anet does **not** ship your `~/.claude` to remote hosts (by design).

## Why this is not a bug

Claude Code CLI's subscription login state is machine-bound and non-portable by Claude CLI's design (credential safety). What anet can do is make **API-key** auth travel with the node (provider store + vault); claude-code-cli subscription login stays with already-logged-in machines.
