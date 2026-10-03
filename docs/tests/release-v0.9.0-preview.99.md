# CommHub v0.9.0-preview.99

This release carries the Hub changes merged since `0.9.0-preview.98`. Production is on `0.9.0-preview.98`. It is built from main at 9fff5feb.

- #2322 (9fff5feb) **Task expiry tells the sender, and never expires a task the node already took (#500).**
  - `patrolExpiredTasks` no longer expires a `created`/`delivered` task whose `consumed_at` is earlier than its `expires_at`. The node picked it up in time. A `consumed_at` stamped after the deadline still expires.
  - When tasks do expire, the sender is notified once per (network, sender, target) per patrol pass:
    - An agent sender gets an inbox reply plus `new_reply` (`status: "expired"`, `requires_response: none`). It is the same shape as `send_reply`, so agent-node and claude-code channels wake and do not answer it.
    - A person (Dashboard / app) gets a `user_inbox` notice of kind `task_expired` in their conversation with the target node.
    - Scheduler-sent tasks and hub / api senders get nothing. The scheduled run already records `expired`.
    - If the expired task has a parent, the parent's sender gets one 「子任务已过期」 notice. The parent's status and result are not changed.
  - Each notice is audited as a `task_events` row with `event_type = task.expiry_notice`.
- Not Hub: #2320 (anet codex model), #2317 (anet logout), the agent-network / agent-node release bumps.

Migration: none.

Behaviour to be aware of: a task the node consumed in time but never answers now stays `delivered` instead of eventually turning `expired`.

Checked:
- **Packed candidate:**
  - Installed with `npm install` into an empty prefix, it resolves `@modelcontextprotocol/sdk` 1.32.0 and `zod` 4.6.5.
  - It starts on an empty HOME and a random port. `/health` answers, unauthenticated `/events/x` returns 401, and the log has no errors.
- **`tests/hub-release-compat`:**
  - Setup: candidate 9fff5feb51e964582192294876d8aac5778056a6, baseline `0.9.0-preview.98` from npm, apps desktop-v0.2.201 / desktop-v0.2.202, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`.
  - A1 and A2: steps=62, unexpected=0, check_failures=0.
  - B upgrade → rollback → re-upgrade: upgrade_check_failures=0.
  - The replay has no expiry step, so the new notice does not appear in it.
- **Read-only `VACUUM INTO` copy of the production database (29 users):**
  - It started on the candidate, then `.98`, then the candidate again, with `COMMHUB_DUE_REMINDERS=0`. Every start answered `/health` with no errors in the log, and `integrity_check` is ok.
  - One patrol pass of the candidate on a copy (patrol every 5 s) expired 0 tasks and sent 0 notices. At copy time, 10 tasks were pending and none were past their deadline. 0 consumed-in-time tasks were past their deadline.
  - For scale: production expired 109 tasks in the last 14 days and 15 in the last 24 hours. Notices are at most that, minus scheduler senders, merged per sender/target per pass.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.99`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.99
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.99
```

No schema change. Existing settings such as `COMMHUB_DUE_REMINDERS` keep working. After the upgrade, senders of tasks that expire start receiving one expiry notice per sender and target per patrol pass.

## Rolling back

`0.9.0-preview.98` starts on a database that `.99` has run on; nothing to undo. Its patrol then expires tasks without notifying anyone, including tasks that were consumed in time. The `task.expiry_notice` events and `task_expired` user notices already written stay as history.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
