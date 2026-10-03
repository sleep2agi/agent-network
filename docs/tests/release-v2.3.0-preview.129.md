# agent-network 2.3.0-preview.129

anet-only release. `PAIRED_AGENT_NODE_VERSION` stays `2.5.0-preview.98`; only `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.129`.

The registry currently serves `2.3.0-preview.128` as `preview`. Changes since `.128`:

- **`anet logout` revokes the login on the Hub** (#513 / #2317). It calls `GET /api/auth/sessions` → `DELETE /api/auth/sessions/<current_token_id>` (the same path as the app's 登录设备 → 退出, Hub ≥ `0.9.0-preview.70`), then clears the local token. Hub unreachable or older than `.70`: the local token is still cleared and a warning says the server-side login is still valid and how to revoke it. API / node tokens are not revoked (warning points to `anet token revoke <id>`). `anet init` / `anet login --hub` pointed at a **different** Hub first revokes the old session on the old Hub, then drops the old token, user and network from the config — the old token is never sent to the new Hub.
- **Codex co-presence nodes use the model from their own config** (#512 / #2320). Model resolution is `--model` > node `config.json` `model` > default, applied to the app-server, the `thread/resume` request and the TUI, on fresh start and resume. Start prints `[anet] model: <id> (source: …)`; on resume it also prints the thread's actual model and warns if it differs. Previously every `anet node start` / `anet node codex start|restart|resume` ran on the default model.
- **Consistent exit codes** (#515 / #2321): `0` success, `1` failure, `2` usage error. The CLI's final `process.exit(0)` no longer overwrites the code a command set, and about 90 error paths that printed an error and returned 0 now exit 1 or 2. `anet hub stop` finds the Hub without `lsof` (`/proc/net/tcp` → `ss` → `lsof` → `netstat`, plus a pid file), and only signals a process whose command line is a `commhub-server`.

## ⚠️ Behaviour change

- **Exit codes (#2321).** Scripts that relied on `anet` returning `0` after an error will now see `1` or `2` — for example `whoami` / `status` / `tasks` when not logged in or with no Hub, `network …` / `token …` failures, `hub start` that never became healthy, `hub stop` that refused, `upgrade` with a failed package, and `create --batch` without `--preset` in a non-interactive shell (now `2`). Under `set -e` such a script now stops. Full table: [CLI guide → 退出码](../../docs-site/docs/guide/cli.md#退出码) / [Exit codes](../../docs-site/docs/en/guide/cli.md#exit-codes).
- **Co-presence model (#2320).** After upgrading, each codex co-presence node switches to the `model` in its `config.json` **on its next restart** (until now it was silently running the default). Check node configs before restarting if any still name an old model. See [codex co-presence → 用哪个模型](../../docs-site/docs/guide/codex-copresence.md#model).

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.129 @sleep2agi/agent-node@2.5.0-preview.98
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.129 @sleep2agi/agent-node@2.5.0-preview.98
```

Upgrade both packages together: anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## promote 时的 must_contain

`"version": "2.3.0-preview.129"`
