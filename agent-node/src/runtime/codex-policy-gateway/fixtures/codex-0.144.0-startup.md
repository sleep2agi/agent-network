# Codex 0.144.0 loopback startup sequence — captured baseline

> **Threat-model note (副指挥 1b24ae71):** the bearer is delivered to
> the child process via an env variable that is visible to any process
> sharing the same UID via `/proc/<pid>/environ`. This design does NOT
> defend against a hostile same-UID sibling. The bearer's protective
> effect is limited to defending against **stale or accidental peers**
> (e.g. a stale process holding a valid but unused connection). True
> same-UID isolation is a Wave 2 OS-isolation P0 item (final wording
> pending 通信龙). No native wrapper / namespace isolation is added in
> Commit 1.

> **Fixture scope note:** the four-read allowlist below (`account/read`,
> `hooks/list`, `configRequirements/read`, `model/list`) is enforced by
> the E2E harness's fake authorizer at
> `scripts/rfc030-real-cli-e2e.mjs`. The production `GatewayLifecycle`
> uses `defaultDenyTuiAuthorizer` (an EMPTY allowlist) — every method
> is denied there. The four-read set belongs to Wave 2's real
> authorizer.


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

## Read-only allowlist (Phase 1)

These four methods are the ONLY upstream reads Codex 0.144.0
performs before the interactive TUI is ready. Under Phase 1 policy
(`read-only` + `approval=never`), the fake TUI authorizer in
`lifecycle.ts` uses this exact set:

    account/read
    hooks/list
    configRequirements/read
    model/list

## Capture notes

- **No emails, tokens, account handles, host paths, or codexHome
  contents** are included in this fixture. The captured `result`
  bodies were reduced to shape assertions only.
- A version bump requires re-capturing. This fixture is bound to
  0.144.0 exactly.
- The `Authorization` header shows `<redacted>` in this doc; the
  live wire carries the actual bearer bytes for exactly one Upgrade,
  after which the bearer is `consumed`.
