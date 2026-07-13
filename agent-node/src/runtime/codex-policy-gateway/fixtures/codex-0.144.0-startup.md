# Codex 0.144.0 loopback startup sequence — captured baseline

> **Threat-model note (副指挥 8eb1dcd1, honest narrowing).** The bearer
> is delivered to the child process via an env variable that is
> visible to any process sharing the same UID via `/proc/<pid>/environ`.
> The bearer's protective effect is limited to defending against
> **accidental / stale peers** and **guessing** (32-byte CSPRNG). It
> does NOT claim to defend against a hostile same-UID sibling — same
> UID is trusted by default. OS-level UID / userns / proc isolation is
> a **Wave 2 OPTIONAL high-security profile**, NOT a default blocker.
> No native wrapper / namespace isolation is added in Commit 1.

> **Fixture scope note.** The four-read allowlist below
> (`account/read`, `hooks/list`, `configRequirements/read`,
> `model/list`) is enforced ONLY by the E2E harness's fake authorizer
> at `scripts/rfc030-real-cli-e2e.mjs`. The production
> `GatewayLifecycle` uses `defaultDenyTuiAuthorizer` (an EMPTY
> allowlist) — every method is denied there. The four-read set belongs
> to Wave 2's real authorizer.

> **Bootstrap-smoke scope note.** The real-CLI harness observes only
> the FIRST authorizer call (`account/read`). The subsequent three
> reads require Codex to receive real responses to `account/read`,
> `hooks/list`, `configRequirements/read` — which the fake harness
> does not provide. Only the first call and the WS Upgrade / bearer /
> env allowlist / SecretRedactor invariants are asserted; the full
> four-read ready sequence is out of scope for this smoke.


Captured 2026-07-12 against `codex-cli 0.144.0` invoked as:

    codex --remote ws://127.0.0.1:<port> --remote-auth-token-env ANET_CODEX_TUI_BEARER

Environment: `CODEX_HOME=<tempdir>`,
`-c check_for_update_on_startup=false`, no other CommHub env slots.

## Wire summary

- Path on Upgrade: **`/`** (bare host:port; adding any path suffix
  triggers CLI's `invalid remote address`).
- Authorization: `Bearer <redacted>` (delivered via `--remote-auth-
  token-env`; the value never appears on the CLI's argv).
- Frames after Upgrade are RFC 6455 text frames carrying JSON.
- `jsonrpc` field is OMITTED on both the initialize request and the
  four read requests. Frozen `classifyMessage` in `protocol.ts`
  already tolerates this (`jsonrpc?: "2.0"`).

## Startup sequence (captured, sanitized)

1. Request:

       {"id":"initialize","method":"initialize","params":{...}}

   Server response (verbatim shape; account/user-derived fields
   redacted):

       {"id":"initialize","result":{"serverInfo":{"name":"codex","version":"0.144.0"},"capabilities":{...}}}

2. Notification (no reply expected):

       {"method":"initialized"}

3. Request `account/read` (×2 — the CLI polls twice on startup):

       {"id":"<uuid>","method":"account/read"}

4. Request `hooks/list`:

       {"id":"<uuid>","method":"hooks/list"}

5. Request `configRequirements/read`:

       {"id":"<uuid>","method":"configRequirements/read"}

6. Request `model/list`:

       {"id":"<uuid>","method":"model/list"}

## Startup reads observed by 0.144.0 (informational)

The four request methods above (`account/read`, `hooks/list`,
`configRequirements/read`, `model/list`) are what Codex 0.144.0
emits before the interactive TUI reaches ready-state — captured for
future reference.

Enforcement scope is deliberately narrow (副指挥 e85ade40 evidence
gate — no more inline "allowlist" wording that contradicts the top
note):

  - `lifecycle.ts` uses `defaultDenyTuiAuthorizer` — the allowlist
    is EXPLICITLY EMPTY (`DEFAULT_DENY_ALLOWLIST.size === 0`). No
    method is permitted by the production authorizer wired into the
    lifecycle. Wave 2's real authorizer will decide which reads are
    permitted.
  - The four-read set above is enforced ONLY by the fake authorizer
    inside `scripts/rfc030-real-cli-e2e.mjs`, and even then only as
    a bootstrap-smoke aid so the smoke can observe the FIRST
    `account/read`. The subsequent three reads require Codex to
    receive real responses to `account/read`, `hooks/list`,
    `configRequirements/read` — which the fake harness does not
    provide. The smoke asserts only the first call.

Do NOT read this section as "the lifecycle permits these four
methods." It does not. The Phase-1 production posture is
default-deny.

## Capture notes

- **No emails, tokens, account handles, host paths, or codexHome
  contents** are included in this fixture. The captured `result`
  bodies were reduced to shape assertions only.
- A version bump requires re-capturing. This fixture is bound to
  0.144.0 exactly.
- The `Authorization` header shows `<redacted>` in this doc; the
  live wire carries the actual bearer bytes for exactly one Upgrade,
  after which the bearer is `consumed`.
