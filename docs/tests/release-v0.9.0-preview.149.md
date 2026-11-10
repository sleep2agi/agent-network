# CommHub Server — a distinct refusal when a node has no live bridge, v0.9.0-preview.149

Ships `main` after `.148`. One wire-visible addition, no behaviour change to any
existing branch.

```
@sleep2agi/commhub-server@0.9.0-preview.149
```

## What changed

- **`session_control_bridge_missing`** (HTTP **409**). The relay used to answer
  `session_control_unavailable` when a node had **no live bridge** — never
  registered, or its 75-second lease expired. That code also covers permission
  refusals, so a client could not tell "this node is not capable / not running"
  from "you are not allowed". `POST /api/node-session-control` now returns the
  distinct code for the no-bridge case; permission refusals keep
  `session_control_unavailable`.

  Why it matters: a desktop client that only sees `unavailable` says "refresh
  later", which is the wrong instruction for a node that simply has not been
  upgraded to `agent-node ≥ 2.5.0-preview.155` (the runtime that registers the
  bridge) or has just restarted.

- Documentation: `getting-started`（中英）更正了一处**事实错误** —— 旧写法是「旧节点
  拒绝 `403 session_control_unavailable`」，实际是 **409**，且现在分成两个码。

Also in this release: `scripts/l1-shard.py` (#2136 first step, CI-only, not used by
any workflow yet) and the `.155`/`.192` release bookkeeping.

## What did not change

- Permission refusals, 401s, `session_control_changed`, `request_expired`,
  `request_limit`, `outcome_unknown` — all unchanged.
- No schema change, no migration, no change to how bridges register.

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v149-preview149"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.149
```

## Upgrade

```bash
# 1) what is running now
curl -s localhost:9200/health | grep -o '"version":"[^"]*"'
# 2) build the new runtime dir (explicit version, never a bare tag)
DIR="$HOME/.commhub/runtime-v149-preview149"
install -d -m 700 "$DIR" && umask 077
printf '{"name":"commhub-runtime","private":true,"version":"1.0.0","dependencies":{"@sleep2agi/commhub-server":"0.9.0-preview.149"}}' > "$DIR/package.json"
(cd "$DIR" && bun install --production)
# 3) point HUB_RUNTIME_DIR at $DIR, then reload
pm2 reload commhub-hub --update-env
# 4) read the version back
curl -s localhost:9200/health | grep -o '"version":"0.9.0-preview.149"'
```

## Rollback

Point `HUB_RUNTIME_DIR` back at `runtime-v148-preview148` and reload. No data
change is involved, so no data rollback is needed.

## Verification

- `server/src/node-session-control-http.test.ts`: 23 pass / 0 fail, including the
  lease-expiry case that now asserts the new code.
- After publishing: `scripts/verify-hub-release.sh 0.9.0-preview.149` must PASS.
