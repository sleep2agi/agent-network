# Release plan (living doc)

> Last updated: 2026-07-16. Owner: release ops. For the version *numbering scheme*
> (npm versions vs bundle tags), see [versioning](../docs-site/docs/guide/versioning.md).

## Current shipped state

| channel | @sleep2agi/agent-network | @sleep2agi/agent-node | notes |
|---|---|---|---|
| **latest** (stable) | 2.2.21 | 2.4.13 | 4 runtimes; ⚠ has the Windows cross-drive `anet --version` crash (#446) |
| **preview** | 2.3.0-preview.33 | 2.5.0-preview.25 | all Windows fixes (#446/#447), `--codex-app-server-url` flag; OpenCode pin temporarily regressed to 1.17.13 |

## In flight → next preview (canonical, `.34` / `.26`)

Built from `main@d050c258` by release ops. One release that unifies the two parallel
preview lines:

- **All Windows fixes** (real-machine verified): `fileURLToPath` (#446), codex-app-server
  node-start dispatch, `where`/`shell:true` spawn, agent-node `isAbsolute` config path (#447)
- **`--codex-app-server-url` / `--codex-thread-id`** create flags (RFC-030), with tightened
  runtime guards
- **OpenCode (RFC-029)**: vetted `opencode-ai@1.18.1` pin restored + release-gate artifacts
- **MCP context**: commhub reply-status semantics baked into agent instructions
  ([details](./agent-reply-to-dashboard.md))

Gate: Linux/OpenCode CI gates by release ops → real-Windows verification → single-point
publish (no more parallel publishing to `@preview`).

## Next stable

- **2.2.22 (latest patch)**: cherry-pick the #446 Windows crash fix onto the 2.2.21 base so
  stable Windows users stop crashing. Blocked on locating the 2.2.21 base commit (no git tag)
  and owner sign-off.
- **2.3.0 (next minor)**: promote the canonical preview line (Windows fixes + codex-app-server
  + OpenCode) to latest once preview has soaked and UAT confirms — per the preview-first policy.

## Policy reminders

- `latest` is never touched by preview publishes; promotion is a deliberate two-phase step.
- Every preview must be real-machine verified before promotion (Linux Docker E2E does not
  catch Windows-specific breakage — see #447 for why).
