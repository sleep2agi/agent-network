# agent-network 2.3.0-preview.132

`anet` CLI release for board #516 (parts 1 and 2). `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.132`; `PAIRED_AGENT_NODE_VERSION` stays `2.5.0-preview.99` (registry-visible, `preview` tag). No agent-node package changes since `.99`: the only commit under `agent-node/` since then (#2335) adds a test file, and the package ships `dist/` only.

## What changed

- **Plain-language errors and masked secrets** (#516 part 1 / #2336):
  - Errors print one plain sentence plus the next command to run; the stack trace only with `ANET_DEBUG=1`. Exit codes unchanged (failure = `1`). Targeted messages for unknown node, EACCES/EPERM/ENOENT/ENOSPC/EROFS/EADDRINUSE, bad JSON, 401/403/404 and unreachable hub. A damaged `~/.anet/config.json` is reported instead of silently reading as "Not logged in". Hub 500 bodies no longer print `[object Object]` or crash `anet node create`. `anet status` says when it could not read the agent list instead of reporting "0 agents".
  - `anet config`, `anet config json`, `anet node start` and `anet doctor` show tokens as `prefix…last4`. `anet node create --env` and `anet node migrate-token-to-envref` write the value to `.anet/nodes/<id>/.env` (600) and print only the masked value plus a load command. Error text redacts `utok_/ntok_/atok_/sk-…`, `Bearer` headers and `token=` query params. One-time reveals (`anet token create`, `anet hub admin reset-user`) are kept.
- **`--help` everywhere; `node delete` removes the Hub row** (#516 part 2 / #2337):
  - Every command and subcommand prints its own usage on `--help` / `-h` and exits 0 without doing any work (before, e.g. `anet network create --help` created a network named `--help`).
  - `anet node delete` now also deletes the Hub row matched by the local `node_id` (never by alias). If the Hub is unreachable or refuses, local files are still removed, a warning prints the retry command `anet node delete <node_id> --hub-only`, and the exit code is `1`. New flag `--hub-only`.

## Behaviour changes to note

- Scripts that grepped full stack traces or full secret values from `anet` output will no longer find them.
- `anet node delete` can now exit `1` when the Hub row could not be removed (local delete still succeeded).

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.132 @sleep2agi/agent-node@2.5.0-preview.99
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.132 @sleep2agi/agent-node@2.5.0-preview.99
```

Upgrade both packages together (`agent-network@2.3.0-preview.132 ↔ agent-node@2.5.0-preview.99`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## promote 时的 must_contain

`"version": "2.3.0-preview.132"`
