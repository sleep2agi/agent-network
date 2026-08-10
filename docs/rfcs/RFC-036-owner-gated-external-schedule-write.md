# RFC-036 — Owner-gated external schedule edits

Status: **security-contract draft; production implementation is intentionally absent**

This RFC extends RFC-034 (Hub-managed scheduled tasks) and the read-only
external-schedule inventory from #185. It does not turn an agent prompt into
host write authority.

## 1. Two resources that must not be confused

| Resource | Execution owner | Existing API | B4 scope |
| --- | --- | --- | --- |
| Hub scheduled task | CommHub scheduler | `/api/scheduled-tasks` | unchanged |
| External schedule | the node host (for example, user crontab) | #185 read-only snapshot | owner-gated timing/enable edits |

The first resource schedules CommHub tasks. The second changes persistent host
state. Network membership is sufficient for the first resource today; it is
**not** authority for the second.

## 2. Security invariants

1. A normal agent turn has no external-schedule write capability. This remains
   true for CommHub tasks, Feishu, Telegram, open IM, and delegated agent turns.
2. The capability is disabled by default and pinned when agent-node starts.
   Enabling it only starts the local control consumer; it does not grant a model
   an MCP tool that can write crontab.
3. Every edit originates from an authenticated `utok_`/Dashboard session whose
   `user_id` exactly equals the target node's immutable `owner_user_id`.
4. A network owner/admin/member who is not the node owner is rejected. There is
   no implicit admin bypass. Ownership transfer is a separate, explicit,
   audited operation and is outside B4.
5. The node consumes an edit only with its token-bound canonical alias,
   `network_id`, and `node_id`. Values supplied in a prompt are never identity.
6. An edit is single-use, expires, is revision-bound, and is applied at most
   once. A stale or replayed edit cannot overwrite newer host state.
7. B4 can alter only timing and `enabled`. It cannot add or replace a command,
   executable, path, environment variable, user, shell, working directory, log
   path, schedule kind, or arbitrary crontab line.
8. Request, delivery, apply and rejection are audited without recording command
   text, host paths, tokens, or secrets.

## 3. Authoritative node owner

For new nodes, `nodes.owner_user_id` is stamped before the node token is
returned. `anet node create` generates the node id first and sends it with the
authenticated user request; Hub creates the node ownership binding and mints
the node token in one transaction. Additional tokens for that node may be
minted only by the same owner. `report_status` can verify but can never create,
replace, or clear this binding.

This is stronger than using the current network role: `api_tokens.user_id` is
Hub-authenticated and bound to the node token; `from`, alias text, and task
content are not.

This avoids a first-heartbeat race in which another network member mints a token
for a known alias and reports first.

Legacy rows with `owner_user_id IS NULL` remain read-only. There is no remote
"first user wins" fallback. A later, separate host-local migration may claim a
legacy row only after it proves all of the following in one transaction:

- authenticated user token and possession of the token in the node's local
  config;
- that node token belongs to the same `user_id`;
- token name is the canonical `node:<alias>`;
- token network, node network and requested network are identical;
- exact node id and a fresh node heartbeat match.

The migration requires an explicit confirmation on the node host and writes an
audit row. It is outside B4 and is not exposed in Dashboard. It never uses
"first network admin", "first heartbeat", or a caller-reported alias as a
fallback.

## 4. Editable object

#185 report entries gain the public, non-secret fields below:

```json
{
  "id": "news-pull",
  "kind": "cron",
  "frequency": "0 */6 * * *",
  "enabled": true,
  "editable": true,
  "revision": 7
}
```

Only entries explicitly discovered inside an Agent Network managed crontab
block are `editable: true`. `systemd`, `tmux`, `playwright`, `custom`, legacy
cron entries, malformed entries and entries without a stable marker stay
read-only in B4.

The wire patch is a strict object:

```ts
type ExternalSchedulePatch = {
  enabled?: boolean;
  cron?: string; // exactly five fields; timing only
};
```

At least one field is required. Unknown keys fail closed. `command`, `path`,
`shell`, `env`, `cwd`, `user`, `kind`, `log_path`, `content`, and newline/control
characters are rejected before an intent is stored. Cron parsing uses one shared
parser on Hub and agent-node; aliases such as `@reboot` and a sixth seconds field
are not accepted in B4.

## 5. Control flow

### 5.1 Dashboard

1. Dashboard loads the #185 snapshot and its revision.
2. `POST /api/nodes/:node_id/external-schedule-edits` carries
   `schedule_id`, `base_revision`, and the strict patch.
3. Hub authenticates the user, verifies exact ownership and network scope, and
   inserts one pending intent plus an audit event in one SQLite transaction.
4. Dashboard shows `pending`, then the node's terminal result. HTTP success means
   accepted for delivery, not applied.

### 5.2 Owner conversation

Natural-language convenience is allowed only on an authenticated Dashboard
conversation. Dashboard creates an owner-action envelope before dispatch. The
envelope contains an opaque intent id, not authority-bearing fields from text.
Agent-node's owner-control consumer receives the structured patch from Hub.

Ordinary messages can ask the model to *propose* an edit, but cannot create an
executable intent. Feishu/Telegram/CommHub senders must confirm through the
authenticated Dashboard control plane.

The model-facing MCP inventory never contains `write_crontab` or an equivalent
raw host-write tool.

### 5.3 Node apply

The separately pinned owner-control consumer polls/pulls with its node token.
Hub returns only a pending intent whose node id, canonical alias, network and
token id match. Agent-node then:

1. locks the private schedule state;
2. re-reads the managed block and checks `base_revision` and immutable command
   fingerprint;
3. parses the requested timing again locally;
4. preserves the existing command bytes and rewrites only the five cron fields
   and/or enabled marker;
5. installs and reads back the crontab;
6. atomically updates private state and revision;
7. ACKs `applied` or a bounded rejection code.

If install succeeds but state persistence fails, agent-node restores the prior
crontab and verifies the restoration before returning failure. A `0600` recovery
journal records before/after hashes and intent id so process death can reconcile
without guessing. Symlinks, foreign-owned files, unsafe parent directories and
non-regular files fail closed. The original command is never sent to Hub.

## 6. Hub storage and audit

`external_schedule_edits` contains:

```text
intent_id, network_id, node_id, schedule_id, base_revision,
patch_json, status, expires_at, created_at, delivered_at, acked_at,
created_by_user, created_by_token, consumed_by_token,
result_revision, error_code
```

There is at most one non-terminal edit for `(node_id, schedule_id)`. Claiming and
state transition use conditional updates in one real SQLite transaction. The
public projection omits all user/token ids and `patch_json` internals not needed
by the UI.

`audit_log` records `external_schedule.edit_requested`, `.delivered`, `.applied`,
`.rejected`, `.expired`, and `.owner_claimed`. Detail contains ids, changed field
names, revisions and error codes only.

## 7. Failures and lifecycle

- stale revision: `409 revision_conflict`, no intent and no host write;
- non-owner or node token on create: `403 node_owner_required`;
- legacy/unclaimed node: `409 node_owner_unclaimed`;
- non-editable entry: `409 schedule_read_only`;
- expired/replayed/foreign intent: no patch returned to node;
- node offline: intent remains bounded pending until expiry;
- node rejects/apply rolls back: terminal `rejected`, error code visible;
- Hub doorbell failure after commit: request stays pending and polling recovers;
- crash at any local apply step: verified old or new state, never an untracked
  half-state.

## 8. Required witnessed-red gates

1. A same-network member who is not `owner_user_id` attempts an edit: current
   behavior must be FAIL, then implementation must return 403 with zero intent,
   audit and host changes.
2. A Feishu/CommHub task tells the agent to change cron: no owner-action envelope,
   so zero intent and zero host changes.
3. A node token calls the user write endpoint: 403.
4. Forged `owner_user_id`, alias, network or node id in JSON cannot affect the
   server-derived identity.
5. `command`, newline injection, `@reboot`, sixth-field cron and unknown keys are
   rejected before persistence.
6. Two editors use one revision: exactly one intent wins.
7. Replaying an applied intent or racing two node consumers changes host state at
   most once.
8. Replace the command between snapshot and apply: fingerprint mismatch, no
   timing rewrite.
9. Install/persist/readback fault injection restores old state; kill between
   steps is reconciled from the private journal.
10. Delete owner check, token binding, revision CAS, command immutability, local
    parser, single-use claim, audit insert, or rollback: the corresponding test
    must turn red.

Layer order is environment → auth/owner → contract validation → Hub transaction
→ local fake-crontab apply → true Hub+SQLite → Docker E2E. A fake Hub cannot
replace the true-Hub layer.

## 9. Non-goals

- creating a new host command from chat;
- editing systemd unit commands, tmux commands, Playwright scripts or custom
  runners;
- giving network admins an implicit node-owner override;
- treating a model's natural-language interpretation as authorization;
- claiming that a queued intent was applied before the node ACK and readback.
