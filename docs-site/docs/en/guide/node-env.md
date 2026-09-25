# Node Environment Variables

The desktop app's **Node settings → 环境变量 (Environment variables)** manages each node's own environment variables and tokens (API keys, gateway URLs, …). Everything else on the node reads them from there: values live in the **`env` block of the node's own `config.json`**, which `agent-node` injects into its process environment at startup and `anet node start` also reads before it launches the node or Claude Code.

Why: a node went offline after a restart because its API key existed only in a hand-typed shell command, not in any file. With the key in `config.json`, a restart no longer depends on anyone remembering that command.

## Using it

- The list shows keys and "set · N chars" only. **Values are write-only**: once saved, nobody (you included) can read them back; you can only overwrite or delete.
- Changes **take effect after the node restarts**. Under the `anet node start` supervisor the app's "save and restart" uses `restart_node`; otherwise (a directly started `agent-node`, a Claude Code session) restart it on its machine with `anet node stop <name>` then `anet node start <name>`.
- "Pending restart" on a key means the running process does not have that value: it has not restarted yet, or its start command exports the same variable, which wins.

MCP tools: `list_node_env` / `set_node_env` / `unset_node_env`; results are polled through `get_rules_file_result` (same doorbell as rules files, skills and the project folder). See [MCP tools](/en/api/mcp-tools).

## Security rules

| Rule | Where |
|---|---|
| User logins only; node tokens are refused (`node_token_cannot_manage_env`); only nodes in your network; only the login that asked can read a result | hub `server/src/tools.ts` |
| Keys must match `^[A-Z_][A-Z0-9_]{0,127}$` and not be reserved: `PATH`, `HOME`, `NODE_*`, `LD_*`, `DYLD_*`, `BUN_*`, `NPM_CONFIG_*`, `XDG_*`, `ANET_*`, `COMMHUB_*`, `*_BINARY`, `RUNTIME`, `ALIAS`, `MODEL`, `CODEX_HOME`, `GROK_HOME`, `SSL_CERT_FILE` and others that would stop the node from starting or hijack it | one pure function `envKeyProblem`, run on the hub and again on the node (byte-identical, pinned by a parity test) |
| Values: non-empty, at most 8 KiB of UTF-8, no NUL | `envValueProblem` |
| A value never appears in a reply, an error message, the audit log or a process log; the audit records key and length only | hub + node |
| The hub drops the value from its row the moment the node acks (only the key stays); timed-out, refused and superseded requests are purged on the spot too, with a one-shot 60 s timer and a 5-minute background sweep as backstops | `purgeEnvRequestValues` |
| On the node: temp file → fsync → rename, mode 0600 (a stricter existing mode is kept), `.prev` backup first; symlinked / hard-linked / foreign-owned `config.json` is refused | `agent-node/src/runtime/node-env.ts` |

## The transport gate: when secrets may not be written

Remote nodes currently reach the hub over plain HTTP through a relay. `set_node_env` is accepted only when **both** legs are encrypted or local:

1. **this call** (app → hub);
2. **the target node's** connection to the hub (measured on every report it makes; when the node pulls the request the hub checks that pull again — a plain-HTTP pull never receives the value, the request fails and the value is purged).

How the hub classifies one connection:

- **loopback**: the socket peer is a loopback address **and** the client dialed a loopback address (the `Host` header). The peer alone is not enough — a tunnel such as frp delivers relayed plain-HTTP connections from `127.0.0.1` too, but their `Host` is the relay's.
- **https**: the hub itself serves TLS; or the peer is loopback and sends `X-Forwarded-Proto: https` (a reverse proxy / tunnel endpoint on the same machine terminated TLS). The header from a non-loopback peer does not count.
- anything else is **plain**. `X-Forwarded-For` is never used.

Otherwise the reply is `insecure_transport` with `leg` = `client` or `node`; the app explains that the node is connected through an unencrypted relay and that writing secrets becomes available once the relay uses encryption. `list_node_env` and `unset_node_env` carry no secret and work over any connection; `list_node_env`'s immediate reply includes `write_allowed` / `write_blocked`, so the app disables "add" **before** you type a secret.

**The gate lifts by itself once the relay gets TLS**: point the node's hub URL at `https://…` and have the TLS-terminating hop send `X-Forwarded-Proto: https`; both legs then classify as https, with no configuration change.

The gate protects against sending secrets over plain HTTP by accident; it is not the authorization boundary (that is the token and network role). Only the token holder, or an active man-in-the-middle on a plain link who already sees the value, could forge `X-Forwarded-Proto`.

## Claude Code sessions

Sessions started by `anet node start` are supported: the launcher injects the `config.json` `env` block into the `claude` process, and the session's channel process (node-server) edits that same file. Claude Code has no exit-75 supervisor, so the restart mode is always manual. A session not started by `anet node start` (it cannot find its own `config.json`) does not report `env_capable`, and the app says why.

## Versions

commhub-server `0.9.0-preview.61`, agent-node `2.5.0-preview.89`, anet (agent-network, needed for Claude Code sessions) `2.3.0-preview.116` or newer. Older nodes do not report `env_capable`; the app says right away what to upgrade.
