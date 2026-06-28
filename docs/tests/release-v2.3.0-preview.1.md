# v0.11-preview2 — release notes

**Tags**: `agent-network@v2.3.0-preview.1` · `agent-node@v2.5.0-preview.1` · server `v0.9.0-preview.1`
**Channel**: `@preview` (use `--tag preview` semantics; not promoted to `@latest`)
**Date**: 2026-06-28

| Package | preview1 | **preview2** |
| --- | --- | --- |
| `@sleep2agi/agent-network` (CLI) | `2.3.0-preview.0` | **`2.3.0-preview.1`** |
| `@sleep2agi/agent-node` (runtime) | `2.5.0-preview.0` | **`2.5.0-preview.1`** |
| `@sleep2agi/commhub-server` (hub) | `0.9.0-preview.0` | **`0.9.0-preview.1`** |

`PINNED_SERVER_VERSION` updated to `0.9.0-preview.1` so `anet hub start` lazy-fetches the matching hub binary (`agent-network/bin/cli.ts:62`).

---

## Install · `@sleep2agi/agent-network@2.3.0-preview.1` · `@sleep2agi/agent-node@2.5.0-preview.1` · `@sleep2agi/commhub-server@0.9.0-preview.1`

**New user — clean install of the v0.11-preview2 channel.**

```bash
# CLI (user-facing entry)
npm install -g @sleep2agi/agent-network@2.3.0-preview.1

# Per-agent runtime (auto-fetched by the wizard; explicit form for reproducible setups)
npm install -g @sleep2agi/agent-node@2.5.0-preview.1

# Commhub server — auto-fetched by `anet hub start`; install explicitly only for direct CLI use
npm install -g @sleep2agi/commhub-server@0.9.0-preview.1
```

Then bootstrap:

```bash
anet --version                 # → 2.3.0-preview.1
anet hub start                 # spawns the pinned hub on :9200
anet init                      # configures hub URL globally
anet init project              # writes .anet/ in the current project (auto-adds .anet/ to .gitignore — v0.11 security)
anet node create               # interactive wizard
anet node start <alias>        # launches the agent-node runtime
```

## Upgrade

```bash
anet upgrade --preview         # tracks the @preview channel
```

Or manually:

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.1
npm install -g @sleep2agi/agent-node@2.5.0-preview.1
# commhub auto-refreshes on next `anet hub start`
```

After upgrade, restart any running nodes so they pick up the new runtime:

```bash
anet node stop <alias>
anet node start <alias>
```

---

## Headline — `/loop` now works for every runtime

Pre-preview2, the `/loop` self-scheduler only ran for the claude-code-cli runtime; agent-node-driven runtimes (claude-agent-sdk / codex-sdk / grok-build-acp) silently skipped goal ticks. Preview2 removes the runtime-bucket skip so every runtime can drive a `/loop` goal end-to-end.

Plus: **new `anet node loop` CLI** for managing goals from outside the agent — set / list / cancel a node's running `/loop` jobs without entering an interactive session.

See `docs/guide/agent-loop.md` (ZH + EN parity).

---

## Security batch

Public-hub deployments only really matter once multiple users / networks live on the same hub. Preview2 closes four cross-tenant / data-integrity gaps:

- **Cross-tenant write防护带** (#287, RFC-024 PR A): 4 new MCP tools (`update_node_config` / `get_config_update` / `ack_config_update` / `restart_node`) that gate every write by `node.network_id == caller.effectiveNetId`, mirroring the #275 pattern. `report_status` upsert now refuses to re-home a node row across networks (the soft underbelly 通信牛 caught). Trust root protected at the SQL layer with the `upsertNodeWithSec1Guard` helper + 5 real-driver regression tests + 6 inline-mirror tests.
- **`retention sweep` + incremental VACUUM** (#282, RFC-024 review item ②): hub now sweeps old tasks / inbox rows on a background schedule, plus splits the `agent_telemetry` index so the periodic READ doesn't accidentally write-amp. Multi-tenant deployments see steadier CPU.
- **Read-path stale-marker fix** (#283, RFC-024 review item ③): sessions stale-mark moved off the read path to a single background sweeper — `/api/status` is no longer a write-amp call.
- **Password KDF strengthening** (#285): existing scrypt path gets a verified-modern parameter set; backwards-compatible (existing hashes still verify; new hashes use the stronger params).

## Engineering hardening

- **`superviseChild()` shared helper** (#284): the `connectFeishu` + `connectSSE` supervisor logic (while-loop respawn + jittered backoff + stable-uptime reset + shutdown gate + abandon-after-timeout) extracted into one helper. Two intentional `connectSSE` improvements landed alongside (±25% jitter to defend against thundering-herd reconnects after a hub restart; backoff no longer resets on a raw HTTP 200, only on the SSE `"connected"` event — fixes a hot ~1s reconnect loop when hub 200s + drops). The helper is the foundation for the v0.11 / v0.12 channel additions.
- **RFC-024 hub config-apply foundation** (#287): the 4 MCP tools + schema (`nodes.config_revision`, `nodes.config_snapshot`, `node_config_updates` table) ship in preview2. Dashboard 改配置真生效 is the consumer side (PR B + PR C) — those merge in a follow-up preview2.x / preview3 once the agent-node-side runtime (PR #290) lands.

## Docs

- `docs/guide/agent-loop.md` (ZH + EN parity): new `anet node loop` CLI + universal `/loop` scheduler (#289)
- Existing RFC-024 design doc (#286) reflects the shipped surface

---

## Verification (pre-publish)

- 3 tarballs built via `npm pack` from absolute paths (per the path-disambiguate convention)
- Docker live install (`node:22-bookworm-slim` + bun + 3 tarballs) — `anet --version` → `2.3.0-preview.1`; `anet hub start` lazy-fetches commhub-server `0.9.0-preview.1`; `/health` returns `version: 0.9.0-preview.1`; admin token saved at mode 600 with random `anet-XX` password (P0-2 random-bootstrap still works on a fresh DB)
- PINNED audit 3-way: source (`PINNED_SERVER_VERSION` const) / Docker live (lazy-fetch succeeds) / npm (`npm view @sleep2agi/commhub-server dist-tags.preview` → `0.9.0-preview.1` post-publish)

## Known limitations

- Dashboard 改配置真生效 chain not yet complete in preview2 — `RFC-024 PR B` (agent-node config-apply runtime + W1 supervisor) + `PR C` (dashboard `HUB_*_PATH` swap) land in a follow-up.
- macOS-specific tmux + setRawMode flows (F family in the release-gate playbook) require Vincent's manual sign-off on macOS — Linux CI doesn't cover.

## Channels

- **Channel**: `@preview` (use `npm install -g <pkg>@<ver>` literally, or `anet upgrade --preview`)
- **NOT promoted to `@latest`** — stable users on `@latest` are unaffected by this release until the maintainer explicitly runs `npm dist-tag add <pkg>@<ver> latest`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
