# Preview docs — v0.11-preview2

::: warning ⚠️ You are reading the **preview** documentation
The current preview channel = **v0.11-preview2** (npm `@preview` tag). This release has **not been promoted to `@latest`** — for stable production use, go back to the [latest documentation](/en/).

**Features available in preview that aren't in latest yet:**
- `anet node loop` CLI + `/aloop` works across all runtimes (Dashboard `/goal` and `/loop` stay native to the target runtime)
- Security batch: cross-tenant write guards + retention sweep + password KDF strengthening
- RFC-024 hub config-apply foundation (4 new MCP tools)
:::

::: tip Install preview via the `@preview` tag
The preview channel keeps iterating and the specific `preview.N` numbers change constantly — don't copy them. Always install and upgrade via `@preview` (the commands below already do); to see what it points at right now, run `npm view @sleep2agi/agent-network dist-tags`.
:::

## Current preview channel canonical build

@preview now points at the **canonical build** (published from the exact tgz after real-Windows verification; independent Linux gate re-run in progress — latest promotion gated on true green):

- **Windows fixes across the board**: cross-drive `anet --version` crash (#446) and the runtime dispatch/detection/spawn Unix-ism cluster (#447)
- **codex-app-server** (RFC-030): `--codex-app-server-url` / `--codex-thread-id` create flags (runtime-guarded)
- **OpenCode** (RFC-029): vetted exact pin `opencode-ai@1.18.1` + full release gates
- The picker is **6-way** (claude-agent-sdk / claude-code-cli / codex-sdk / codex-app-server / grok-build-acp / opencode-cli; verified against the published .34 bundle — grok-build-cli is not in it)
- MCP context ships the reply-semantics note (terminal status pushes to the Dashboard)

Install: `npm i -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview`

---

## Three-package versions (preview2, 2026-06-28 snapshot)

| Package | preview1 | **preview2** |
|---|---|---|
| `@sleep2agi/agent-network` (CLI) | `2.3.0-preview.0` | **`2.3.0-preview.1`** |
| `@sleep2agi/agent-node` (runtime) | `2.5.0-preview.0` | **`2.5.0-preview.1`** |
| `@sleep2agi/commhub-server` (hub) | `0.9.0-preview.0` | **`0.9.0-preview.1`** |

`PINNED_SERVER_VERSION` updated to `0.9.0-preview.1` — `anet hub start` lazy-fetches the matching hub binary automatically.

## Install

### Clean install (new user)

```bash
npm install -g @sleep2agi/agent-network@preview
npm install -g @sleep2agi/agent-node@preview
npm install -g @sleep2agi/commhub-server@preview
```

Bootstrap:

```bash
anet --version              # → 2.3.0-preview.N (N = current preview number)
anet hub start              # spawns the pinned hub on :9200
anet init                   # configures the hub URL globally
anet init project           # writes .anet/ in the current project (auto-adds .anet/ to .gitignore — v0.11 security)
anet node create            # interactive wizard
anet node start <alias>     # launches the agent-node runtime
```

### Upgrade (existing user tracking the preview channel)

```bash
anet upgrade --channel preview
```

Restart any running nodes so they pick up the new runtime:

```bash
anet node stop <alias>
anet node start <alias>
```

Full upgrade workflow + cross-version migration: [Upgrade Guide](/en/guide/upgrade).

## Quickstart — try `/aloop` in 60 seconds

Want to try ANet recurring scheduling across runtimes right after upgrading? Follow these steps:

```bash
anet upgrade --channel preview                              # 1. Upgrade to the preview channel
anet --version                                              # 2. Confirm 2.3.0-preview.N (current preview)
anet node start <alias>                                     # 3. Make sure the node is online
anet node loop <alias> "what time is it now" --every 5m     # 4. Schedule a recurring task (every 5 min)

# Manage loops ↓
anet goal list <alias>                                      # 5a. List loops (task/interval/next_wake/status)
anet goal edit <alias> <goal-id> --interval 10min           # 5b. Change the interval
anet goal edit <alias> <goal-id> --status paused            # 5c. Pause (status: active/paused/completed/cancelled)
anet goal cancel <alias> <goal-id>                          # 5d. Cancel
```

**Text-equivalent form** (Dashboard Chat or another surface that delivers text to the node):

```
/aloop 5m what time is it now
```

**Notes**:

- Starting in preview2, all production runtimes (`claude-agent-sdk` / `claude-code-cli` / `codex-sdk` / `grok-build-acp`) can run ANet goal scheduling; the current text command is `/aloop`
- Interval units: `60s` / `5m` / `30m` / `2h` / `1d`, **minimum 60s**
- Replace `<alias>` with your node alias (`anet node ls`); get `<goal-id>` from `anet goal list <alias>`
- Full command reference + persistence + restart behavior: [Agent Node — Loop scheduler](/en/guide/agent-node#recurring-tasks-the-loop-scheduler)

## preview2 highlights (with deep links)

### 🌟 ANet goal scheduling works for every runtime + `anet node loop` CLI

Before preview2, the ANet self-scheduler only ran for the `claude-code-cli` runtime; agent-node-driven runtimes (`claude-agent-sdk` / `codex-sdk` / `grok-build-acp`) **silently skipped** goal ticks. preview2 removed that runtime-bucket skip; use `/aloop` for these tasks now.

Plus: **new `anet node loop` CLI** to manage goals from outside the agent — set / list / cancel a node's running ANet jobs.

```bash
anet node loop my-codex "monitor PR #271" --every 5m
anet node loop researcher "scan twitter for grok updates" --every 30m
anet node loop daily-bot "post the morning summary" --every 2h
```

📖 Full usage + trigger mechanics → [Agent Node — Loop scheduler](/en/guide/agent-node#recurring-tasks-the-loop-scheduler)

### 🔒 Security batch (4 items)

Four cross-tenant / data-integrity gaps closed for public-hub multi-user / multi-network deployments:

- **Cross-tenant write guards** ([#287](https://github.com/sleep2agi/agent-network/issues/287), RFC-024 PR A)
- **retention sweep + incremental VACUUM** ([#282](https://github.com/sleep2agi/agent-network/issues/282))
- **read-path stale-marker fix** ([#283](https://github.com/sleep2agi/agent-network/issues/283))
- **Password KDF strengthening** ([#285](https://github.com/sleep2agi/agent-network/issues/285))

📖 Full description → [Changelog — v0.11-preview2 Security batch](/en/changelog#v0-11-preview2-—-loop-works-for-every-runtime-security-batch-rfc-024-hub-config-apply-foundation-2026-06-28-🟡-preview)

### 🛠 Engineering hardening

- `superviseChild()` shared helper (feishu/SSE supervisor extraction)
- RFC-024 hub config-apply foundation (4 MCP tools + schema)

### Not in preview2 yet

- RFC-024 PR B (agent-node config-apply runtime) — separate PR #290, queued for preview2.x / preview3
- Dashboard end-to-end config-apply — PR C, lands after PR B

## latest vs preview comparison

| Feature | latest (npm `latest`) | preview (`2.3.0-preview.N`) |
|---|---|---|
| ANet `/aloop` scheduler | `claude-code-cli` only | **All production runtimes** |
| `anet node loop` CLI | ❌ | ✅ |
| Cross-tenant write guards | Partial (`#275`) | ✅ 4 tools + SQL guard |
| retention sweep / VACUUM | ❌ | ✅ |
| Password KDF | Basic scrypt | ✅ verified-modern parameters |
| RFC-024 hub config-apply | ❌ | ✅ foundation (PR A) |
| Docker one-command (`docker/feishu/`) | ✅ (since preview1) | ✅ |
| Feishu channel | ✅ (since preview1) | ✅ |

## Full release notes

→ [Changelog v0.11-preview2 full entry](/en/changelog#v0-11-preview2-—-loop-works-for-every-runtime-security-batch-rfc-024-hub-config-apply-foundation-2026-06-28-🟡-preview)

## References

- [Versioning](/en/guide/versioning) — npm-package versions vs `v0.11.x` bundle releases
- [Upgrade Guide](/en/guide/upgrade) — preview ↔ latest switch + cross-version migration
- [GitHub release v0.11-preview2](https://github.com/sleep2agi/agent-network/releases) — GH-side release tag
- Switch back to [latest documentation](/en/) — if you want the stable release
