# CommHub v0.9.0-preview.70

This release carries one new Hub change, already on main. It stacks on `0.9.0-preview.69`: an instance on `.68` that upgrades
straight to `.70` also gets #2112 (P3 `lowest` priority plus its one-time `requirements` table rebuild; see `release-v0.9.0-preview.69.md`).

- #2114 (60ae151dec67ab47f9042b1ef9eb5da90b2a6146) **Sign-in sessions expire when idle, and a signed-in devices API.**
  - **Sign-in session tokens:** every token with `scope='user'` and no bound network, whatever its name. In practice these are named
    `user-login` (login / register), `password-change` or `admin-reset`. They now stop working after `COMMHUB_SESSION_IDLE_DAYS` days without use.
    The default is 30, and `0` turns expiry off. Idle time is counted from `last_used_at`, or from `created_at` for a token never used. Every use extends it.
  - **Not affected:** API tokens created with `POST /api/auth/tokens` (`scope='full'`) and node/network tokens (`ntok_`).
  - An expired token gets `401 {"error":"token_expired"}` on every endpoint. A token that was never valid keeps its old error.
  - `last_used_at` is written at most once per token per hour (it used to be written on every request).
  - Login and register responses include `token_id`. Login accepts an optional `client_label`, and the Hub records the `User-Agent`.
  - New endpoints, which accept user tokens only (a node token gets `403 user_token_required`):
    `GET /api/auth/sessions`, `POST /api/auth/sessions/revoke-others`, `DELETE /api/auth/sessions/:id`.
    App 0.2.156+ uses them for the 设置 → 账号 → 登录设备 page.

## 🔴 What happens to existing tokens at the first start

Expiry is not a fresh 30-day grace period counted from the upgrade. It uses each token's real idle time:
- A sign-in session token idle for **more than 30 days at upgrade time is rejected immediately** with `token_expired`.
  By definition, nobody has used it in 30 days.
- Every other sign-in token expires once it has been idle for 30 days. Apps, the Dashboard and the CLI in active use keep extending theirs.
- Count the tokens that would expire immediately, read-only, before upgrading:

  ```sql
  SELECT COUNT(*) FROM api_tokens
  WHERE scope = 'user' AND network_id IS NULL AND revoked_at IS NULL
    AND COALESCE(last_used_at, created_at) < datetime('now', '-30 days');
  ```
- Escape hatch: start with `COMMHUB_SESSION_IDLE_DAYS=0` (off) or a larger value.
- Someone whose token has expired signs in again. App 0.2.156+ shows 「登录已过期，请重新登录」.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.70`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.70
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.70
```

For an existing instance, the operator backs up the database in an authorised window, then restarts the process with its usual service manager.

Migrations at startup (additive): `api_tokens.client_label` and `api_tokens.user_agent`, both nullable.
Coming from `.68`, the `.69` `requirements` table rebuild also runs once.

The package contains no existing data, users, network members or secrets. To roll back, use `0.9.0-preview.69` (or `.68`) with a previously
prepared data restore plan. Do not drop production tables or overwrite published packages. The new columns stay in the database and older
versions ignore them. After a rollback, tokens that `.70` rejected as idle work again, because rejection revokes nothing: it is a check at read time.
