# RFC-001: Deprecate COMMHUB_AUTH_TOKEN, consolidate on user tokens

| Field        | Value                                  |
| ------------ | -------------------------------------- |
| Status       | **Accepted** (Vincent, 2026-05-11)     |
| Created      | 2026-05-11                             |
| Updated      | 2026-05-11 (dashboard simplification)  |
| Author       | Vincent (sleep2agi)                    |
| Implementer  | 通信牛 / SDK马                          |
| Target       | server v0.8.0 → v1.0                   |
| Discussion   | [#3](https://github.com/sleep2agi/agent-network/issues/3) |

## Summary

We have three tokens in the hub today: `utok_` (user), `ntok_` (network-scoped node), and `COMMHUB_AUTH_TOKEN` (service master key). The master key predates the V3 auth schema and is no longer pulling its weight — `utok_` with `role=admin` covers every legitimate use case it serves. This RFC proposes removing `COMMHUB_AUTH_TOKEN` over two minor versions, with a hard cutoff at v1.0.

## Motivation

Why the status quo is bad:

1. **Cognitive load for users who will never need it.** End users learn `anet login` (gets `utok_`) and `anet node create` (gets `ntok_`). The master token only matters for self-hosters running a multi-tenant hub — and even there it offers no advantage over an admin `utok_`. Docs already have to apologize for the concept (`docs-site/docs/concepts/tokens.md:126` literally headers the section "Advanced · only relevant if you deploy a hub").

2. **Three concepts where one would do.** `requireAuth()` in `server/src/index.ts:98-112` tries `resolveToken()` first, then falls back to `token === AUTH_TOKEN`. That fallback is the only reason `isLegacyAuthToken()` exists (`index.ts:93-96`), the only reason `/events/:alias` has the special-case branch at `index.ts:339-348`, and the only reason `auth_token` exists in `~/.anet/server/config.json` (`bin/cli.ts:1865, 1952, 2083`).

3. **No audit trail.** A request authenticated by `COMMHUB_AUTH_TOKEN` has no user, no network, no token name. The audit log row attributes the action to nothing. Anything done through the master token is effectively anonymous-but-authorized.

4. **No role binding.** Master token grants are all-or-nothing. There's no way to limit a service to `read` or scope it to one network. Admin `utok_` with `scope`/role enforcement (R12 from the security report) gives us a real permission model.

5. **Security audit pressure.** The status quo is implicated in three findings from `docs/open-source-security-risk-report.md`:
   - **R3 (Critical)** — open-mode startup is gated on `COMMHUB_AUTH_TOKEN` being unset. Once `COMMHUB_AUTH_TOKEN` is gone the open-mode codepath collapses to one explicit `--dev-open` flag, which is much harder to trip over by accident.
   - **R4 (Critical)** — `requireAuth()` accepts the master token, which is what allows the tmux WebSocket to authenticate without being tied to a user. Tying tmux access to admin `utok_` lets us actually attribute the session.
   - **R7 (High)** — MCP read tools don't verify network membership when the caller is the master token, because the master token has no user/network. Removing the master path forces every caller to have a `userId`/`networkId`, which makes `canRead()` enforceable everywhere.

## Current state

`COMMHUB_AUTH_TOKEN` enters the system in five places:

1. **Server startup gate.** `server/src/index.ts:11` reads it from env. `index.ts:22-25` refuses to start if it is unset and `--dev-open` was not passed. The banner string at `index.ts:14` and the `/health` payload at `index.ts:709-710` both echo whether it is set.

2. **`requireAuth()` fallback.** `server/src/index.ts:107-109`:
   ```ts
   // Legacy: check global COMMHUB_AUTH_TOKEN
   if (!AUTH_TOKEN && DEV_OPEN) return null;
   if (token === AUTH_TOKEN) return null;
   ```
   This is the path that lets a bearer of the master token call `/mcp`, `/events/:alias`, and every `/api/*` endpoint without a `user_id` ever being resolved.

3. **SSE legacy branch.** `server/src/index.ts:339-348` — when `isLegacyAuthToken(req)` is true (and only then), SSE subscribes without doing membership scoping. This is one of the cleanest deletions: with `COMMHUB_AUTH_TOKEN` gone, R8 from the security report ("SSE doesn't check token/network") fixes itself.

4. **CLI lifecycle.** `agent-network/bin/cli.ts` reads/writes the master token in four places:
   - `:1860` reads `process.env.COMMHUB_AUTH_TOKEN` as a fallback for `anet hub start`.
   - `:1865, :1952` saves `auth_token` into `~/.anet/server/config.json`.
   - `:2083` lets `anet hub config --token <t>` overwrite it.
   - `:2103-2116` passes it to the Dashboard subprocess via env so the Dashboard can talk to the hub.

5. **Documentation.** `docs-site/docs/concepts/tokens.md`, `docs-site/docs/deploy/production.md`, `docs-site/docs/api/rest.md`, the bilingual CLI guides, and the docker deploy doc all reference it. Most are aimed at self-hosters.

Notably: agent nodes never use the master token. They all have `ntok_`. So removing master will not affect a single user-installed agent.

## Proposed design

### 1. Admin endpoints use admin-role `utok_`

The hub already issues `role=admin` to the first registered user (`server/src/auth.ts:33-42`). `requireAdminAuth()` (`server/src/index.ts:129-136`) already does the right thing: resolve token → check `user.role === "admin"`. We extend coverage so that every endpoint currently relying on `COMMHUB_AUTH_TOKEN` for elevated privilege explicitly calls `requireAdminAuth()`.

Example: tmux WebSocket today is `requireTmuxAccess` → `requireAdminAuth`, which already requires admin `utok_`. After this RFC, the same pattern applies to the catch-all `/api/*` admin block and to anything that previously authenticated via the master token without a user.

```ts
// Before
const authErr = requireAuth(req);   // accepts master token, no user
if (authErr) return authErr;

// After (for elevated endpoints)
const authErr = requireAdminAuth(req);   // resolved utok_, role=admin
if (authErr) return authErr;
```

For non-elevated endpoints (`/mcp`, `/events/:alias`, REST reads), `requireAuth()` keeps its `resolveToken()` path and drops the master-token fallback. Every successful auth produces a `userId` and (for `ntok_`) a `networkId`.

### 2. Dashboard is a thin proxy — holds NO token

After discussion (issue #3 reply from maintainer), the previous proposal of giving the Dashboard its own service token is **dropped**. The Dashboard backend holds zero credentials.

**Single model, same-machine and cross-machine**:

```
1. Operator starts Dashboard:    anet hub dashboard --hub https://hub.example.com
                                  (Dashboard knows only the hub URL. Zero token persisted.)

2. User opens browser:           https://dashboard.example.com

3. User submits username + password to Dashboard login page.

4. Dashboard backend POSTs credentials to hub /api/auth/login,
   gets back a `utok_` with the user's role baked in,
   writes it as an HTTP-only session cookie scoped to the Dashboard origin.

5. Every subsequent browser → Dashboard request:
   Dashboard backend reads the `utok_` from the cookie,
   forwards it as `Authorization: Bearer utok_…` on the call to the hub.

6. Hub authorizes by the `utok_`'s embedded role.
```

**Why this is strictly better than holding a service token**:

- Zero long-lived service credential to be stolen if the Dashboard host is compromised — only currently-online users' session cookies are exposed (and they rotate with each `anet login`).
- Every hub call is attributable to a real user. The audit log shows real identities, not "the Dashboard did it." This resolves the old Open Question 2 by construction.
- Cross-machine deployment becomes the same flow as same-machine — just point at the hub. No extra steps, no token copying, no `admin-utok.json` to chmod.
- No code path exists in the Dashboard for "service identity" — fewer pieces to test, fewer pieces to misconfigure.

**The `admin-utok.json` file is still created** by `anet hub start` (so that local-only CLI commands like `anet hub admin reset` can authenticate without prompting), but the Dashboard does not read it.

### 3. Bootstrap

First-run `anet hub start` already creates an admin account today (`bin/cli.ts:1969-2001`). We tighten this:

- After admin creation, also create one named `utok_` (token name e.g. `admin-bootstrap`) and persist it to `~/.anet/server/admin-utok.json` with `chmod 600`:
  ```json
  {
    "username": "admin_a1b2c3",
    "user_id": "u_...",
    "token": "utok_...",
    "created_at": "2026-05-11T..."
  }
  ```
- The banner continues to show the admin username + one-time password.
- The banner additionally shows `Admin token saved (used by dashboard)` — no value printed.
- No env var is exported into the user's shell. Nothing for the user to copy.

### Removed code paths (final state at v1.0)

- `AUTH_TOKEN` constant in `server/src/index.ts:11`.
- `isLegacyAuthToken()` and its call sites.
- The `if (token === AUTH_TOKEN) return null;` branch in `requireAuth()`.
- The SSE legacy branch at `index.ts:339-348`.
- The `auth_token` field in the server config JSON schema.
- The `--token` flag of `anet hub start` (replaced by login flow; admin token is internal).
- `COMMHUB_AUTH_TOKEN` env var: no longer read anywhere; warned in v0.8 and ignored in v1.0.

## Migration plan

### Phase 1 — v0.7.x (in-flight, no breaking change)

- Keep `COMMHUB_AUTH_TOKEN` working exactly as it is.
- CLI continues to auto-manage `auth_token` in `~/.anet/server/config.json`; users never type it.
- **Cancel** the previously planned `anet hub token` subcommand. We are deprecating the concept, so we are not adding user-facing CLI surface for it.
- No new docs mentioning master token. Existing docs stay until Phase 2.

### Phase 2 — v0.8.0 (new flow ships, old flow soft-deprecated)

- Server boots admin `utok_` on first run (`admin-utok.json` lands).
- `requireAdminAuth` enforced on tmux + admin REST endpoints; master-token branch in `requireAuth` still present **but only for `/api/*` reads**, gated behind a warning log:
  > `[commhub] master-token auth is deprecated and will be removed in v1.0. See RFC-001.`
- CLI:
  - `anet hub dashboard` uses admin `utok_` from `admin-utok.json` (falls back to `COMMHUB_AUTH_TOKEN` with the same deprecation warning if the file is missing).
  - `anet hub config --token` writes to the file with a deprecation warning.
  - Silent-ignore `auth_token` in `config.json` if present (warning logged once at startup, value not used by hub).
- Dashboard switched to admin `utok_`.
- **Open-mode default removed.** `anet hub start` without `--dev-open` always provisions an admin user + token. The "no token configured → open mode" path is gone. R3 closes.
- `COMMHUB_DEV_OPEN=1` and `--dev-open` still work for the offline-tutorial case, with a louder banner.

### Phase 3 — v1.0 (hard removal)

- All code paths listed under "Removed code paths" above are deleted.
- `auth_token` in `~/.anet/server/config.json` is unrecognized (warning + ignored, schema validator rejects in strict mode).
- `COMMHUB_AUTH_TOKEN` env var is unread. Setting it has no effect.
- Docs purged of all master-token references.
- `SECURITY.md` and the security risk report's R3/R4 entries get a "resolved in v1.0 by RFC-001" footnote.

## Compatibility

What **does not break**:

- Existing agents running `ntok_` keep working unchanged. `ntok_` is a row in `api_tokens`, completely independent of master.
- Existing user CLIs/Dashboards that already have a `utok_` in `~/.anet/global.json` keep working.
- Hubs running v0.5.x or v0.7.x continue to accept `COMMHUB_AUTH_TOKEN` from old clients during Phase 2 — they just log a warning.
- The hub's SQLite DB schema is unchanged. No migration needed.

What **does** break:

- **CI scripts** that set `COMMHUB_AUTH_TOKEN=...` in their environment: warning in v0.8, fail (auth rejected) in v1.0. Migration: `anet login` to get an admin `utok_`, store that as a secret.
- **Third-party integrations** that hardcoded the master token as a service credential: same as above.
- **Operators who put `auth_token` in `~/.anet/server/config.json`**: silent-ignore + warning in v0.8, unrecognized field in v1.0. The hub no longer needs it because admin token bootstrap is automatic.
- **Open-mode-by-default deployments** (e.g. someone running bare `commhub-server` with no env): refused to start without `--dev-open`. Already true since v0.5.x for `commhub-server`, but `anet hub start` was papering over it by auto-generating a master. In v0.8 the auto-generation switches to admin-user bootstrap. Behavior changes only for users who started `commhub-server` directly without env — and they get a clear error message pointing to `anet hub start`.

## Recovery / edge cases

**Admin user accidentally deleted, or admin password lost:**
A new CLI subcommand, `anet hub admin reset`, runs locally on the hub host. It:

1. Reads the SQLite DB directly (`~/.commhub/commhub.db`), bypassing the HTTP API.
2. Refuses to run unless invoked with `--i-am-on-the-hub-host` or by a process whose `cwd` is the hub's data dir.
3. Generates a new random password, updates `users.password_hash` for the admin row (or recreates the admin row if missing).
4. Issues a fresh admin `utok_`, writes it to `admin-utok.json` (chmod 600), and prints the new password once.
5. Does **not** revoke other admin tokens — leaves that as an explicit follow-up the operator can do via `anet token revoke`.

There is no networked recovery path. If you lose admin access on a hub you can't shell into, you cannot recover — that's by design, and consistent with the local-first product direction.

**Dashboard cross-machine deployment:** trivially `anet hub dashboard --hub https://hub.example.com`. The Dashboard backend holds no token; each browser session establishes its own. No file copying, no per-host setup. (See Proposed design §2.)

**Migration of pre-V3 hubs:** any hub that predates the `api_tokens` table is already incompatible with v0.5+; this RFC does not change that.

## Alternatives considered

1. **Keep `COMMHUB_AUTH_TOKEN` but make it CLI-invisible.** Rejected. It still shows up in audit logs as "no user", still requires special-case code in `requireAuth`, still confuses contributors reading the source. The whole point is to delete the concept, not hide it.

2. **mTLS / cert-based auth between Dashboard and hub.** Rejected. anet is a local-first product. Most users run hub + dashboard on the same laptop. Cert provisioning is over-engineering and would add a separate parallel auth path on top of the token one we already have.

3. **Per-instance service tokens (Dashboard service token, CLI service token, etc).** Rejected. anet has no cluster, no service mesh, no Kubernetes. There is one hub and a handful of admin-equivalent callers. Admin `utok_` plus optional per-name admin tokens (`anet token create --name dashboard`) gives all the granularity anyone will reach for, without inventing a new token type.

4. **Issue Dashboard a non-admin `service` scope.** ~~Rejected for v1.0~~ — superseded 2026-05-11 by the simpler "Dashboard holds no token" model (Proposed design §2). The Dashboard is now a thin cookie-forwarding proxy; there is no service identity to scope.

## Open questions

1. **~~Dedicated Dashboard service token~~** — **Resolved** 2026-05-11: the Dashboard holds no token (see Proposed design §2). Audit-log attribution falls out for free.

2. **Where does `anet hub admin reset` live?** Two options:
   - Its own subcommand under `anet hub admin ...`.
   - A flag on `anet doctor --fix` ("found broken admin user, recreate?").
   Preference: a dedicated `anet hub admin reset` so it shows up in `--help` and is obviously a recovery tool. `anet doctor` should detect-and-suggest, not silently mutate.

3. **Bunx caching of old `commhub-server` versions.** The CLI pins `PINNED_SERVER_VERSION` to defeat bunx caching (`bin/cli.ts:1900`). When v0.8 ships, users on older CLI will pull old server. We need to coordinate the bump or accept a one-release window where the old server still accepts master tokens (it will — the soft-deprecation in v0.8 covers this).

4. **The `--token` flag on `anet hub start`.** Currently used by power users and by some test scripts. Phase 2 keeps it (with warning). Phase 3 removes it. Are there in-tree tests under `tests/` that use it? Implementer should grep and migrate before v1.0.

## Approval

| Role        | Name                | Status   |
| ----------- | ------------------- | -------- |
| Maintainer  | Vincent (sleep2agi) | pending  |
| Implementer | 通信牛 / SDK马        | pending  |

Implementation tracking: open a tracking issue referencing this RFC once approved; link the Phase 2 / Phase 3 PRs from the issue.
