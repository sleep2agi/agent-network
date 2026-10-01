# CommHub v0.9.0-preview.80

This release carries the Hub change merged since `0.9.0-preview.79` (cut from 42232e86). Production is on `0.9.0-preview.79`.

- #2201 (aea6caabe614631b05dcdc2e6fc1fc0a384d77f3) **Participants may change a task's status and checklist, and the other people on the card are notified.** Owner decision 2026-10-01.
  - A human participant on a task (including a member scoped to related tasks) may change `column` and `checklist`, through `PATCH /api/requirements/:id`, the checklist-item PATCH, and the MCP tools `requirements_update` / `requirements_checklist_toggle`. Every other field stays owner / creator / editable-project-grant only; a request carrying any other field is rejected as a whole with the existing 403 `{error:"task_read_only"}`, now with `field` and a Chinese `message`.
  - `viewer_can` gains an optional `edit_fields: ["column","checklist"]` on such cards. `viewer_can.edit` is unchanged.
  - Notification: when a participant (not the owner) makes such a change, the owner, the creator and the other participants receive a human DM from the actor, titled 「任务更新」, with `meta.task_notice {requirement_id, seq, network_id}`. Humans only, deduplicated, never the actor. Changes by the same actor on the same card within 60 s are merged into the recipient's still-unread notice (rewritten under the same message id) instead of a new message.
  - App 0.2.170 / 0.2.171 keep working unchanged: they ignore `edit_fields`, so a participant still sees the card as read-only until the app that uses it ships.

No other server change is in this release.

Checked in Docker with `tests/hub-release-compat`, candidate aea6caabe614631b05dcdc2e6fc1fc0a384d77f3 (clean tree), baseline `0.9.0-preview.79` from npm, apps 0.2.162–0.2.171 (`APP_TAGS` set explicitly):
- A1 and A2: steps=62, unexpected=0, check_failures=0 each.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.

#2201's own tests (14 new HTTP tests plus updated task-access tests) cover allowed fields, rejected fields, recipients, coalescing and scoped visibility; eight mutations each turn a test red. The PostgreSQL ladder passed with the new suite registered.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.80`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.80
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.80
```

No new migrations and no new tables. Notices are ordinary rows in the existing user inbox.

## Rolling back

`0.9.0-preview.79` starts on a database that `.80` has run on, since `.80` changes no schema. After a rollback, participants are read-only again; notices already delivered stay in recipients' DM threads.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
