# CommHub Server — node tokens stay inside their network, v0.9.0-preview.152

Ships `main` after `.151`. One permission fix in the API added by `.151`, plus a
test-only change. No schema change, no new endpoint.

```
@sleep2agi/commhub-server@0.9.0-preview.152
```

## What changed

- **`GET /api/networks/:id/rules` no longer lets a node token read another
  network's rules.**

  `.151` allowed a read when the caller was a member *or* a hub admin. A node
  token resolves to the human who minted it, so a node minted by an admin passed
  the admin branch and could read **any** network's rules. A node token is now
  confined to its own network: `403 not_a_member` otherwise.

  Why it matters even though nothing consumes the rules yet: the rules document is
  what every node in a network is meant to obey, and `.151` is publicly live. A
  cross-network read of that document should not stay in the field overnight.

- **Test only:** the two native Windows capture tests in
  `agent-network/src/windows-stop-identity.test.ts` now carry an explicit 60 s
  timeout. They spawn `cmd.exe` plus three PowerShell invocations; bun's default
  per-test timeout is 5 s, so the job failed by timing out (`timed out after
  5000ms`, while the same job passed on 11 of the previous 12 `main` runs).
  Assertions and product code are unchanged.

## What this release does NOT do

- It still does **not** make any node read these rules. Inheritance
  (Hub → Daemon → node), precedence and injection are the next slice and need a
  product decision first.
- No UI, and a node's `CLAUDE.md` / `AGENTS.md` is untouched.

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v152-preview152"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.152
```

## Upgrade

```bash
# 1) what is running now
curl -s localhost:9200/health | grep -o '"version":"[^"]*"'
# 2) build the new runtime dir (explicit version, never a bare tag)
DIR="$HOME/.commhub/runtime-v152-preview152"
install -d -m 700 "$DIR" && umask 077
printf '{"name":"commhub-runtime","private":true,"version":"1.0.0","dependencies":{"@sleep2agi/commhub-server":"0.9.0-preview.152"}}' > "$DIR/package.json"
(cd "$DIR" && bun install --production)
# 3) point HUB_RUNTIME_DIR at $DIR, then reload
pm2 reload commhub-hub --update-env
# 4) read the version back
curl -s localhost:9200/health | grep -o '"version":"0.9.0-preview.152"'
```

## Rollback

Point `HUB_RUNTIME_DIR` back at `runtime-v151-preview151` and reload. The change is
a permission check in one handler; `.151` remains structurally compatible (same
schema, same endpoints).

## Verification

- `server/src/network-rules-http.test.ts`: 8 pass — member reads an empty document
  as revision 0 · a plain member cannot write · admin writes then reads back · a
  stale `expected_revision` is 409 and does not overwrite · a node token cannot
  write · **a node token cannot read another network's rules** · oversized content
  is 413 (bytes) · a non-member cannot read.
- Live check performed on `.151` before the fix, to make sure the finding was real:

  ```
  GET /api/networks/<mine>/rules  → 200 {revision:0}
  PUT /api/networks/<mine>/rules  → 403 user_token_required
  GET /api/networks/net_nope/rules → 200   ← the bug
  ```

- After publishing: `scripts/verify-hub-release.sh 0.9.0-preview.152` must PASS.
