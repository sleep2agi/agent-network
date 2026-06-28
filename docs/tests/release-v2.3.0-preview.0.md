# v0.11-preview1 — release notes

**Tags**: `agent-network@v2.3.0-preview.0` · `agent-node@v2.5.0-preview.0` · server v0.9.0-preview.0
**Channel**: `@preview` (use `--tag preview` semantics; not promoted to `@latest`)
**Date**: 2026-06-28
**Packages**:

| Package | Previous (preview) | This preview |
| --- | --- | --- |
| `@sleep2agi/agent-network` (CLI) | `2.2.22-preview.4` | `2.3.0-preview.0` |
| `@sleep2agi/agent-node` (runtime) | `2.4.15-preview.2` | `2.5.0-preview.0` |
| `@sleep2agi/commhub-server` (hub) | `0.8.8` | `0.9.0-preview.0` |

`PINNED_SERVER_VERSION` in the CLI is updated to `0.9.0-preview.0` so `anet hub start` lazy-fetches the matching hub binary.

---

## Install · `@sleep2agi/agent-network@2.3.0-preview.0` · `@sleep2agi/agent-node@2.5.0-preview.0` · `@sleep2agi/commhub-server@0.9.0-preview.0`

**New user — clean install of the v0.11-preview1 channel.**

```bash
# CLI (user-facing entry)
npm install -g @sleep2agi/agent-network@2.3.0-preview.0

# Per-agent runtime (installed automatically by the wizard; explicit form below for reproducible setups)
npm install -g @sleep2agi/agent-node@2.5.0-preview.0

# Commhub server (NOT required to install manually — `anet hub start` lazy-fetches the pinned 0.9.0-preview.0 via npx)
# If you want a global install for direct CLI use:
npm install -g @sleep2agi/commhub-server@0.9.0-preview.0
```

Then run the standard bootstrap:

```bash
anet --version                 # → 2.3.0-preview.0
anet hub start                 # spawns the pinned hub on :9200
anet init                      # configures hub URL globally
anet init project              # writes .anet/ in the current project (auto-adds .anet/ to .gitignore — v0.11 security)
anet node create               # interactive wizard
anet node start <alias>        # launches the agent-node runtime
```

## Upgrade

**Existing user — upgrading from a prior preview or from `@latest`.**

The supported upgrade path is the bundled `anet upgrade` command:

```bash
anet upgrade --preview         # tracks the @preview channel
```

If you previously installed packages by hand, the equivalent npm commands are:

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.0
npm install -g @sleep2agi/agent-node@2.5.0-preview.0
# (the hub auto-fetches 0.9.0-preview.0 the next time you run `anet hub start`)
```

After upgrade, restart any running nodes so they pick up the new runtime:

```bash
anet node stop <alias>
anet node start <alias>
```

### ⚠ Migration callout — telegram allowlist semantics

v0.11 **flips the telegram `allowFrom` default to fail-closed**: an empty or missing `allowFrom` in `access.json` now denies every inbound message (was: allowed all). Combined with the default `dangerouslySkipPermissions` runtime flag, the previous fail-open default was a remote-execution vector. The change-add wizard has always required a non-empty `allowFrom`, so most users are unaffected; only operators who hand-edited `access.json` to clear the list need to migrate.

**Recovery** (preserve the previous wildcard semantics): edit `.anet/nodes/<alias>/channels/telegram/access.json` and set:

```json
{ "allowFrom": ["*"] }
```

A loud one-shot boot warning surfaces in `agent-node` logs whenever an empty / malformed `allowFrom` is detected so the new posture is visible on the first message.

> B1 ([#276](https://github.com/sleep2agi/agent-network/pull/276)) and B2 ([#278](https://github.com/sleep2agi/agent-network/pull/278)) are the security PRs that land this; they merge in the preview1 batch alongside the rest of this release. If your preview1 install was published before either PR merged, this section reflects what will land in preview1 follow-up.

---

## What's in this preview

### P0 — incident-class fixes

- **Feishu worker supervised re-fork on death** (#261 P0-1, PR #263) — the IM bridge child process now respawns with exponential backoff + jitter. Pre-fix, a crashed bridge left the agent silently disconnected.
- **Hub default admin creds randomised** (#261 P0-2, PR #264) — `anet hub start` on a fresh DB generates a one-time random `anet-XX` password and forces a change on first login (`must_change_password` column). No more shared default credentials across deployments.

### Runtime hardening (cross-vendor)

- **claude-agent-sdk 429 / quota fast-fail + empty-result soft-fail** (PR #267, then folded into the cross-runtime utils below) — silent vendor rate-limit no longer rebrands as "task complete". Vendor-specific remediation hint URLs (deepseek / intern / anthropic / minimax / mimo).
- **Shared runtime utils — `withTimeout` + `classifyRuntimeResult`** (#261 P1 redirect, PR #272) — unified timeout primitive consumed by claude / codex / grok handshake / telegram getUpdates. Codex had zero wall-clock guard pre-fix; now bounded by `CODEX_TIMEOUT_MS`. Grok handshake decoupled from prompt deadline (default `min(45s, timeoutMs)`).
- **Result classifier — three-zero silent-reject** — strict rule: `in=0 AND out=0 AND cost=0` (all three) flags as soft-fail-empty; empty result string also flags; `output_tokens === 0` alone with non-empty text is success (codex usage is not reliably reported).

### Security (latent leak fixes — see Migration callout above)

- **B1 — telegram `allowFrom` fail-closed + shared access resolver** (PR #276) — pure helper consumed by telegram + feishu; 68 unit tests pin the new fail-mode against regression.
- **B2 — `.anet/` auto-ignore in project-root `.gitignore`** (PR #278) — protects `access.json` + per-node tokens from `git stash -u` / `git clean -fd` (2026-06 incident shape).

### Server-side

- **Cross-tenant write blocker** (round5 F1+F2, PR #275) — `send_task` with `parent_task_id` is now network-scoped on inference, ownership-checked on explicit input, and re-checked at every `chainReplyToParent` hop.
- **SSE memory-leak fix** (round5 follow-up) — long-lived SSE clients no longer accumulate unbounded listener state.

### CI / docs

- **CI guard for internal memory-slug references** (PR #274) — Python grep guard blocks `[[<type>_<slug>]]` references from leaking into public OSS files. Cleaned 6 P0 references; 57 legacy references in `docs/sop/` / `docs/rfcs/` / etc. are allowlisted pending owner audit.
- **Release-gate workflow** (PR #270) — install-smoke + PINNED audit + release-notes shape gates run automatically on every `v*.*.*-preview.*` tag push.
- **Feishu quickstart docs** updated for the supervised re-fork + new credential rotation flow (post #263 / #264).

### Onboarding robustness — 5 fixes

- `anet node create` wizard runs through to completion under both interactive TTY and non-TTY pipe input (regression coverage for #135 / #137).
- `anet hub start` admin token now persists at mode 600 with the random bootstrap password surfaced once on stdout.
- `anet upgrade --preview` flow tested end-to-end against the new pin chain.
- Docker baseline image switched to `node:22-bookworm` (drops alpine — claude-agent-sdk binary needs glibc).
- `agent-node` boot path emits a one-shot warning when `allowFrom` is empty or malformed (visibility for the v0.11 fail-closed flip).

---

## Verification

- **Release-gate workflow** (auto-fires on tag push) — install-smoke (Gate 1) + PINNED audit (Gate 2) + release-notes shape (Gate 3)
- **Clean Docker install smoke** (`node:22-bookworm`):
  - `npm install -g <tarball>` for the three packages from absolute paths
  - `anet --version` matches `2.3.0-preview.0`
  - `anet hub start` boots; `curl :9200/health` returns 200
  - `anet node create` reaches the wizard's first prompt under pexpect-driven real-TTY drive
- **PINNED audit** — `PINNED_SERVER_VERSION` in `agent-network/bin/cli.ts` matches the published `commhub-server@0.9.0-preview.0`

## Known limitations

- macOS-specific tmux + setRawMode flows (F family in the release-gate playbook) are not exercised by the Linux CI — Vincent's manual sign-off on macOS still required for promotion to `@latest`.
- The 57 legacy `[[feedback_*]]` references in `docs/sop/` / `docs/rfcs/` etc. are temporarily allowlisted by the slug guard; documentation owners will audit + rewrite at their own pace.

## Channels

- **Channel**: `@preview` (use `npm install -g <pkg>@<ver>` literally, or `anet upgrade --preview`)
- **NOT promoted to `@latest`** — stable users on `@latest` are unaffected by this release until the maintainer explicitly runs `npm dist-tag add <pkg>@<ver> latest`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
