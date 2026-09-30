# CommHub v0.9.0-preview.74

This release carries the Hub changes merged since `0.9.0-preview.73` (cut from ffdf9280). Production is on `0.9.0-preview.73`.
**It adds database migrations; read "Migrations at startup" and "Rolling back" before upgrading.**

- #2163 (b25c98d30a7ea2e34cbcc0e52803821a626eb997) **Who can see which tasks: `task_access` + project grants (RFC-038 §9 step 1).**
  - Each network member has `task_access`, either `all` (every task, the old behaviour) or `scoped`.
    Scoped members see only the tasks they own, take part in or created, plus the projects they are granted (read or edit).
  - **Existing members are `all`** (column default), so what they see does not change.
  - **New members also default to `all`** (#2174, ec7fd18d4e48168b85678ba421e1b32bdf812d9a). This covers admin-created accounts, `POST …/members` and invite codes, so nothing changes for anyone until an owner or admin scopes a member.
    Scoping is done in app 0.2.164 (「任务范围」) or through the API. Making `scoped` the default for new members is a separate, later owner decision.
  - A task a member may not see returns the same 404 as a missing one. Changes are audited.
  - New API: `GET` / `PUT /api/networks/:id/members/:user_id/task-grants`. `/api/auth/me` networks gain `task_access`.
- #2168 (6615058946d93c68073a1af14895b04826156fb0) **Task completion time and `GET /api/requirements/stats` (task dashboard).**
  - Cards gain `completedAt`, `completedAtApprox` and `completedBy`. They are set when a card enters `done` and cleared when it leaves.
  - `stats` counts the caller's visible cards, archived included: totals, a daily series in the caller's time zone, by project, by completer, and recent completions.
- #2169 (5d0aaafed91794091d20c4945048fa16c2490018) **Tag management (`tag_ops`).**
  - `POST /api/requirements/tags/ops` renames, merges, deletes or colours a tag across every card in the network, in one transaction. It is audited.
  - `GET /api/requirements/tags` keeps `tags` as before and adds `counts`, `colors` and `can_manage`. The list capabilities gain `tag_ops`.
  - Owners, Hub admins and `task_access='all'` members may manage tags; scoped members, viewers and node tokens get 403.
- #2170 (b56e0b5b22c60ac6d779341f12ae1071d76a1286, restored by #2178 873e49596552f04dc1ea0d7efe4cb7af1ab1aea0) **DM files are readable only by the people in the DM.**
  - #2172 (de5c3cd8, an anet-only change) reverted it by accident, and #2178 restored it byte-for-byte. The server side of #2172 is exactly that revert plus the restore, so it has no net effect on the Hub.
  - Files uploaded with `?purpose=dm` (app 0.2.164) can be downloaded only by the uploader, the people in a DM that carries them, and admins.
  - Files uploaded any other way keep their current access.
- #2176 (0cb6dc4c0955e76845e78e4a9e1dfed55c9cad2d) **Replies to scheduled tasks are unread for the person who created the schedule.**
  Before this they were addressed to `scheduler`, so they showed in the chat but never raised the unread badge, a notification or the 「新消息」 float.
  Now they go to the schedule creator's inbox. They fall back to `scheduler` when the creator is gone or their username collides with a node alias. Existing `scheduler` rows are left as they are. No schema change.
- #2166 (5dd96fed705e888cfcb2111aae7f085952760ef8) **Member role-change / remove audit rows record `network_id`.**

Checked against apps 0.2.162, 0.2.163 and 0.2.164 in Docker, with `0.9.0-preview.73` as the baseline:
- Every response an app already reads keeps its fields and types; the only changes are additions.
- A member who existed before the upgrade sees the same cards with the same values after it, after a rollback to `.73`, and after upgrading again.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.74`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.74
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.74
```

For an existing instance, the operator backs up the database in an authorised window (`VACUUM INTO` or `sqlite3 .backup`, never a copy of the `.db` file alone), then restarts the process with its usual service manager.

Migrations at startup. All of them are idempotent and run on every start; a second start changes nothing.
- `network_members.task_access TEXT NOT NULL DEFAULT 'all'` (#2163). Existing rows get `all`.
- New table `network_member_project_grants(network_id, user_id, project_id, can_edit, created_by, created_at)` with index `idx_project_grants_project` (#2163).
- `requirements.completed_at TEXT`, `completed_by_json TEXT`, `completed_at_approx INTEGER NOT NULL DEFAULT 0`, and the partial index `idx_requirements_network_completed` (#2168). Then a reconciliation:
  - cards in `done` without `completed_at` get their `updated_at` (else `created_at`) with `completed_at_approx = 1` and no completer;
  - cards outside `done` that still carry a completion are cleared.
- New table `network_tags(network_id, name, color, updated_at)`, which stores tag colours only (#2169).
- #2170 and #2176 change no table. Upload index entries of `?purpose=dm` files carry `scope: "dm"`.

## Rolling back

`0.9.0-preview.73` starts on a database that `.74` has migrated, and existing members see the same cards (checked in Docker: .73 → .74 → .73 → .74 on one database). It ignores the new columns and tables, so while `.73` runs:
- **scoped members see every task again**, as before `.74`, and project grants have no effect;
- **DM-scoped files fall back to `.73`'s download rules**, which know nothing about DM scope. Access is no longer limited to the DM's participants;
- tag colours are not shown (the tags on cards are unchanged);
- completion times are not maintained.

Back on `.74`, grants, scopes and colours apply again, and the startup reconciliation fixes completion times for cards moved in or out of `done` during the rollback.

Treat a rollback as a temporary widening of access. Do not drop the new tables or columns, and do not overwrite published packages. The package contains no existing data, users, network members or secrets.
