# CommHub Server — per-node team-rules state in `/api/status`, v0.9.0-preview.154

Ships `main` after `.153`. One additive API field plus four nullable columns; nothing
in the runtime path changes for nodes that never report it.

```
@sleep2agi/commhub-server@0.9.0-preview.154
```

## What changed

- **Each session row in `/api/status` can carry `team_rules`** — one word telling an
  operator whether that node has the network's current rules:

  ```json
  "team_rules": {
    "state": "current | outdated | failed | never",
    "applied_revision": 3,
    "current_revision": 3,
    "status": "injected",
    "reason": null,
    "at": "2026-10-24T12:00:00Z"
  }
  ```

  - `current` — the applied revision equals the network's current revision;
  - `outdated` — **this node has not restarted since the rules changed** (not a failure);
  - `failed` — the last attempt ended in an error; `reason` says why;
  - `never` — never attempted, or nothing was applied on the last attempt.

- **`report_status` accepts `team_rules`** from `agent-node >= 2.5.0-preview.156` and
  stores `team_rules_revision / status / at / reason` on the session row. Every field is
  parsed leniently (`.catch(...)`): a malformed value must never reject the whole status
  report, because that would mark a healthy node offline.

**Why "outdated" is its own word:** v1 injects at a node's full start, so a node that
simply has not restarted is behind by design. Reporting that as `failed` would send
someone to debug a node that is doing exactly what it should.

## Compatibility

- **Additive.** A session that never reported has **no `team_rules` key at all** — the
  response bytes for old clients are unchanged.
- **The `?light=1` projection is untouched** (it has a byte-identical contract and is what
  the mobile list and the alias resolver read).
- `SELECT` on `network_rules` is guarded: a Hub that has never served the rules API does
  not have that table yet, and "no table" is treated as "no rules" rather than a 500.

## What this release does NOT do

- It does not change how rules reach a node (still `ANET_TEAM_RULES=1` + a full restart).
- No client page yet: the state is available over the API, not in the UI.
- Daemon-scoped rules, cross-layer conflict arbitration and a combined size cap remain
  open product decisions (RFC-043 §8).

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v154-preview154"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.154
```

## Upgrade

```bash
# 1) what is running now
curl -s localhost:9200/health | grep -o '"version":"[^"]*"'
# 2) build the new runtime dir (explicit version, never a bare tag)
DIR="$HOME/.commhub/runtime-v154-preview154"
install -d -m 700 "$DIR" && umask 077
printf '{"name":"commhub-runtime","private":true,"version":"1.0.0","dependencies":{"@sleep2agi/commhub-server":"0.9.0-preview.154"}}' > "$DIR/package.json"
(cd "$DIR" && bun install --production)
# 3) point HUB_RUNTIME_DIR at $DIR, then reload
pm2 reload commhub-hub --update-env
# 4) read the version back
curl -s localhost:9200/health | grep -o '"version":"0.9.0-preview.154"'
```

The four new `sessions` columns are added with an idempotent `ALTER TABLE … ADD COLUMN`
(the same helper every other session column uses), so an existing database upgrades in
place. They are nullable: existing rows read as "never reported".

## Rollback

Point `HUB_RUNTIME_DIR` back at `runtime-v153-preview153` and reload. `.153` does not read
the four new columns and does not emit `team_rules`; the columns stay but are ignored, so
no data rollback is needed.

## Verification

- `server/src/team-rules-status-http.test.ts` — 4 pass: a session that never reported has
  no key; behind → `outdated` with both revisions; equal → `current`; error → `failed`
  with its reason; `?light=1` never carries the field.
- `server/src/team-rules-status.test.ts` — 8 pass: the derivation itself, including a
  malformed report that must not throw and must not invent a revision.
- `server/src/status-read-cache-http.test.ts` — 10 pass: the existing byte-identical and
  cache-invalidation contracts still hold with the new field.
- `server/src/network-rules-http.test.ts` — 11 pass: rules storage/permissions unaffected.
- `scripts/check-mutation-pins.py` → GREEN; `scripts/check-doc-claims.py` → 8/8.
