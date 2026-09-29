#!/usr/bin/env bash
# test2123-hub-postgres-ladder — how far does the Hub get on a real PostgreSQL?
#
# RFC-039 S1. The Hub has a DATABASE_URL=postgres:// entry but no CI job had
# ever pointed it at a real server. This suite does, and reports the highest
# rung reached:
#
#   L0  adapter connects to PG ("PostgreSQL connection verified")   ← always required
#   L1  schema built and hub listening (/health 200)
#   L2  first registered user is admin
#   L3  login → node token → report_status → POST /api/task
#   L4  send_reply ok and the task row is replied
#
# It is a ratchet, not a pass/fail smoke: the suite is red only when the level
# drops below FLOOR. Each RFC-039 step that moves the Hub up a rung raises
# FLOOR in the same PR. Reaching above FLOOR prints a note, never red.
#
# Everything is inside this container: Postgres on 127.0.0.1, a throwaway
# HOME, a non-default port. NODE_ENV is not "test", so the adapter's
# test-env DATABASE_URL guard is not involved (it refuses inherited URLs
# under `bun test`; this is an ordinary hub process with a URL built here).
set -euo pipefail
printf 'source_commit=%s\n' "${SOURCE_COMMIT:-unknown}"
# CI passes the commit it built; an image built from something else must not
# report a level on this commit's behalf.
if [ -n "${EXPECTED_SOURCE_COMMIT:-}" ] && [ "$EXPECTED_SOURCE_COMMIT" != "${SOURCE_COMMIT:-}" ]; then
  echo "FAIL: source provenance mismatch image=${SOURCE_COMMIT:-unset} expected=$EXPECTED_SOURCE_COMMIT"
  exit 1
fi

# Current floor: on main the Hub dies while building its schema on PG
# (RFC-039 §1.3), so L0 is the highest rung it reliably reaches.
FLOOR="${PG_LADDER_FLOOR:-0}"
SUITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG_PORT=25433
HUB_PORT=29213
HUB_WAIT_SECS="${HUB_WAIT_SECS:-300}"

WORK="$(mktemp -d /tmp/test2123.XXXXXX)"
chmod 0755 "$WORK"
export HOME="$WORK/home"; mkdir -p "$HOME"
PGDATA="$WORK/pgdata"; PGSOCK="$WORK/pgsock"
mkdir -p "$PGDATA" "$PGSOCK"; chown postgres:postgres "$PGDATA" "$PGSOCK"

HUB_PID=""
cleanup() {
  [ -n "$HUB_PID" ] && kill "$HUB_PID" 2>/dev/null || true
  if [ -n "${ARTIFACT_DIR:-}" ]; then
    mkdir -p "$ARTIFACT_DIR"
    cp "$WORK/hub.log" "$ARTIFACT_DIR/test2123-hub.log" 2>/dev/null || true
    cp "$PGSOCK/pg.log" "$ARTIFACT_DIR/test2123-pg.log" 2>/dev/null || true
  fi
  runuser -u postgres -- "$PG_BIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
}
trap cleanup EXIT

PG_BIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -n 1)"
echo "[pg] $("$PG_BIN/postgres" --version)"
runuser -u postgres -- "$PG_BIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
runuser -u postgres -- "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$PGSOCK/pg.log" -w \
  -o "-p $PG_PORT -k $PGSOCK -c listen_addresses=127.0.0.1" start >/dev/null
runuser -u postgres -- "$PG_BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" -U postgres commhub

# Positive control for the harness itself: the database we are about to hand
# the Hub answers a query. Without this a dead Postgres would read as "Hub
# can't reach L0" — a harness failure dressed up as a product finding.
runuser -u postgres -- "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U postgres -d commhub -Atc 'select 1' | grep -qx 1
echo "[pg] ready on 127.0.0.1:$PG_PORT"

cd /work/server
env -u NODE_ENV -u COMMHUB_DB \
  DATABASE_URL="postgres://postgres@127.0.0.1:$PG_PORT/commhub" \
  PORT="$HUB_PORT" HOST=127.0.0.1 \
  bun src/index.ts >"$WORK/hub.log" 2>&1 &
HUB_PID=$!

health() {
  bun -e "fetch('http://127.0.0.1:$HUB_PORT/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1
}

LEVEL=-1
FIRST_FAIL=""
up=0
t0=$SECONDS
for _ in $(seq 1 "$HUB_WAIT_SECS"); do
  if health; then up=1; break; fi
  kill -0 "$HUB_PID" 2>/dev/null || break
  sleep 1
done

if grep -q 'PostgreSQL connection verified' "$WORK/hub.log"; then LEVEL=0; fi

if [ "$up" = 1 ]; then
  LEVEL=1
  ladder_out="$(bun "$SUITE_DIR/ladder.ts" "http://127.0.0.1:$HUB_PORT" 2>&1 || true)"
  printf '%s\n' "$ladder_out"
  reached="$(printf '%s\n' "$ladder_out" | sed -n 's/^LADDER_LEVEL=//p')"
  [ -n "$reached" ] && LEVEL="$reached"
  FIRST_FAIL="$(printf '%s\n' "$ladder_out" | grep -m1 '^FAIL ' || true)"
else
  hub_rc="running"
  kill -0 "$HUB_PID" 2>/dev/null || { wait "$HUB_PID" 2>/dev/null && hub_rc=0 || hub_rc=$?; }
  # The first line bun prints for an uncaught error is "error: <message>".
  err="$(grep -m1 -E '^(error|Error)[: ]' "$WORK/hub.log" || true)"
  FIRST_FAIL="FAIL L1 hub not listening after $((SECONDS - t0))s (hub exit=$hub_rc): ${err:-see hub.log}"
  echo "$FIRST_FAIL"
fi

echo "--- hub.log (tail) ---"
tail -n 25 "$WORK/hub.log" || true
echo "----------------------"

echo "PG_LADDER level=$LEVEL floor=$FLOOR first_fail=${FIRST_FAIL:-none}"

if [ "$LEVEL" -lt 0 ]; then
  echo "RESULT: FAIL — the Hub never reported a PostgreSQL connection (L0). Harness or adapter selection is broken."
  exit 1
fi
if [ "$LEVEL" -lt "$FLOOR" ]; then
  echo "RESULT: FAIL — regressed below the floor (level $LEVEL < floor $FLOOR)."
  exit 1
fi
if [ "$LEVEL" -gt "$FLOOR" ]; then
  echo "NOTE: level $LEVEL is above the floor $FLOOR — raise FLOOR in run.sh in this PR."
fi
echo "RESULT: PASS (level $LEVEL, floor $FLOOR)"
