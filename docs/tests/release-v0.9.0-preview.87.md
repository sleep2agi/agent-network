# CommHub v0.9.0-preview.87

This release carries the Hub change merged since `0.9.0-preview.86`. Production is on `0.9.0-preview.86`.

- #2244 (a943dbda3d537ec8d27bf72e03b362ce35fa2b57) **Notify the node owner once when model login goes bad (#462, part of #448).**
  - When a node's own token reports `health.model_auth` = `revoked` or `expired` (agent-node ≥ 2.5.0-preview.94), the Hub sends one message titled 「节点登录失效」 to the node's owner: which node, what happened, and how to re-login (`CODEX_HOME=<节点目录>/codex-home codex login`; do not copy another node's `auth.json`).
  - Owner = the node's `owner_user_id`; a legacy token with no bound node falls back to the user who minted it. Nobody else is notified. An owner who has left the network gets nothing.
  - Delivered through the existing `user_inbox` + `/events/users/me` `desktop_message` path (`kind=node_model_auth`, `severity=warning`, `from_session` = node alias). The app already shows it in that node's conversation, with unread badge and notification; no app change.
  - Once per transition into a bad state; only an `ok` report re-arms it. `unknown` or no report neither notifies nor re-arms. `revoked ⇄ expired` is the same episode. Marks are in memory; after a Hub restart the first bad sighting is suppressed while the owner still has an unread notice from that node.
  - Only the node's own token can trigger it; another node or a user login reporting on its behalf does nothing.
  - No account switching and no auth sharing: detect and notify only.

No other server change is in this release. No schema change.

Checked in Docker with `tests/hub-release-compat`, candidate a943dbda3d537ec8d27bf72e03b362ce35fa2b57 (clean tree), baseline `0.9.0-preview.86` from npm, apps 0.2.166 / 0.2.181 / 0.2.193, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`:
- A1 and A2: steps=62, unexpected=0, check_failures=0 each.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.87`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.87
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.87
```

No migration; the database is not changed by this release.

## Rolling back

`0.9.0-preview.86` starts on a database that `.87` has run on with no difference: `.87` adds no tables or columns. Notification dedup marks are in memory only; messages already delivered stay in `user_inbox` as ordinary inbox rows.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
