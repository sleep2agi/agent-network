# commhub-server 0.9.0-preview.279

Since `.278`: fork/attach no longer refuses a healthy source+daemon pair as stale.

## What changed

```text
#3416  session-source-issuer  source/daemon liveness window 75 s → 4 min (SOURCE_LIVENESS_MS).
       Nodes and daemons report every 3 min, so 75 s made a healthy pair look stale most of the
       time and app fork returned 403 (live: TMA客户端欧 90 s, daemon-vdev 150 s since last report).
       Liveness prerequisite only; the daemon's live evidence read remains the proof.
```
(`.278`: get_all_status 10 s cache.)

## Verified

- `session-source-issuer` 11/11 (stale at −5 min and future; fresh at −2 min)
- `session-source-evidence` 37/2 (= main, env-only), `session-source-directory-http` 17/17; tsc 196 (= main)

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.279
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.279
# production: install into ~/.commhub/runtime-0-9-0-preview-279, point hub-daemon.sh at it, pm2 restart commhub-hub
```

## What it does not do

- Does not relax token binding, ownership or network checks.
