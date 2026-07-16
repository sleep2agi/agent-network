# Stability tiers — what is rock-solid vs. still moving

> Living doc. Last updated: 2026-07-16. Purpose: when iterating, know what you must
> NOT break (Tier 0/1), what to touch carefully (Tier 2), and where fast iteration is
> fine (Tier 3). Companion to the [release plan](./release-plan.md).

## Tier 0 — Protected core. Do not change without explicit owner sign-off

Verified daily by the whole fleet in production; everything else depends on these.

| capability | evidence |
|---|---|
| Hub task lifecycle: `send_task` → deliver → `send_reply`(terminal) → `new_reply` SSE | the entire agent fleet coordinates through it daily; [reply semantics](./agent-reply-to-dashboard.md) |
| SSE session registry + `report_status` (who's online) | dashboard + fleet rely on it continuously |
| SQLite storage (WAL) + salted-scrypt auth + login rate-limiting | security-audited against source; docs verified |
| Dual token model (`utok_` user / `ntok_` node) | every node handshake uses it |
| `claude-code-cli` runtime | Tier-1 reliability; all long-running production nodes use it |
| anet CLI basics: `login` / `node create/start/stop/ls` / `hub start` / `doctor` / `--version` | real-machine verified on published latest 2.2.21 (Linux) |
| Release policy: preview-first, `latest` never touched by preview publishes | enforced process |
| Frozen baseline `703374e` (gateway protocol) | frozen by decree — do not touch |

**Rule: any PR touching Tier 0 needs a real-machine smoke (not just unit/mocks) before merge, and preview soak before promote.**

## Tier 1 — Reliable, but with known sharp edges

Works in production; edges are documented. Change with tests + the edge in mind.

| capability | sharp edge |
|---|---|
| `claude-agent-sdk` runtime + vendor adapters | vendor-dependent behavior; adapter bias only fires on known base-URLs |
| `codex-sdk` runtime | works; real OAuth flow not covered by CI |
| `grok-build-acp` runtime | formally integrated; not on E2E |
| `anet upgrade` | auto-installs + auto-self-upgrades by default (since #154) — docs were stale on this until recently |
| Telegram channel | per-node state dir required; allowlist can be swept by git clean |
| Feishu channel | config/ARG drift history; restart requires exact-PID discipline |
| Dashboard chat (send + new_reply display) | reply must use terminal status; see Tier 0 row |

## Tier 2 — Preview / actively moving. Iterate freely, gate before promote

Expect breakage; that is what the preview channel is for.

- **codex-app-server** (RFC-030, Phase 0A): a Windows/dispatch bug cluster was just fixed
  (#446/#447); co-presence verified on real Windows once — not yet soaked
- **opencode-cli** (RFC-029): preview-only, pinned `opencode-ai` version
- **grok-build-cli co-presence**: preview
- **Windows support overall**: fixes exist in preview only; `latest` 2.2.21 still crashes
  cross-drive until 2.2.22 ships
- Dashboard panels beyond chat basics (org views, config editing, M2+ interaction work)

## Tier 3 — Known broken right now (fix, don't build on)

- anet.sh docs deploy frozen since Jul 2 (Vercel git integration; needs dashboard action)
- Prod dashboard transport (HTTP/2 / SSE proxy) — causes chat-history timeouts and delayed
  reply display; hub itself answers in milliseconds
- `latest` on Windows when cwd drive ≠ install drive (#446; fixed in preview)

## Why things felt chaotic — and the countermeasures already in place

1. **Parallel preview publishing** by two owners clobbered `@preview` → now single-point
   publish from a canonical main base.
2. **Linux-only E2E** missed Windows Unix-isms (`/bin/sh`, `which`, spawn without shell,
   `startsWith("/")`) → real-machine verification is now part of the gate.
3. **Silent semantics** (reply status, lazy runtime fetch) surprised even maintainers →
   being documented as discovered (this doc, reply doc, release plan).
