#!/usr/bin/env bash
# RFC-039 S5 — `commhub-server migrate-to-pg`, end to end, inside the test2123
# container. Called by run.sh with PG_BIN PGSOCK PG_PORT WORK SUITE_DIR
# LADDER_PW exported. Prints PASS/FAIL lines; exit status is the verdict.
#
#   seed      a real Hub on SQLite climbs the ladder (admin, network, task,
#             reply), then stops cleanly
#   refusals  source open in a running Hub, source under ~/.commhub,
#             non-empty target
#   dry run   verifies everything, leaves the target empty
#   tamper    a mutated copy that changes one value on the way in fails
#             verification, rolls back and leaves the target empty
#   migrate   the real copy commits; the Hub boots on it and climbs L1–L5
#             again as the migrated admin
set -euo pipefail

fails=0
pass() { echo "PASS migrate: $*"; }
fail() { echo "FAIL migrate: $*"; fails=$((fails + 1)); }

psql_admin() { runuser -u postgres -- "$PG_BIN/psql" -h "$PGSOCK" -p "$PG_PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
for db in mig_target mig_dry mig_nonempty mig_tamper; do
  psql_admin -d postgres -c "CREATE DATABASE $db OWNER anet_ladder"
done
psql_admin -d mig_nonempty -c "SET ROLE anet_ladder; CREATE TABLE already_here (x int)"
url() { echo "postgres://anet_ladder:$LADDER_PW@127.0.0.1:$PG_PORT/$1"; }
public_objects() {
  psql_admin -d "$1" -Atc "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public')
    + (SELECT COUNT(*) FROM information_schema.sequences WHERE sequence_schema='public')
    + (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema='public')"
}
health() {
  bun -e "fetch('http://127.0.0.1:$1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1
}
wait_health() {
  local port=$1 pid=$2
  for _ in $(seq 1 120); do health "$port" && return 0; kill -0 "$pid" 2>/dev/null || return 1; sleep 1; done
  return 1
}
MIGRATE=(bun /work/server/bin/commhub.ts migrate-to-pg)
cd /work/server

# ── seed: a real SQLite Hub, outside ~/.commhub ──
SEED_DIR="$WORK/seed"; mkdir -p "$SEED_DIR"; SEED="$SEED_DIR/commhub.db"
env -u DATABASE_URL -u COMMHUB_PG_EXPERIMENTAL COMMHUB_DB="$SEED" PORT=29214 HOST=127.0.0.1 \
  bun src/index.ts >"$WORK/seed-hub.log" 2>&1 &
seed_pid=$!
if wait_health 29214 "$seed_pid"; then
  seed_out="$(bun "$SUITE_DIR/ladder.ts" http://127.0.0.1:29214 2>&1 || true)"
  if printf '%s\n' "$seed_out" | grep -qx 'LADDER_LEVEL=5'; then pass "seed Hub on SQLite reached L5"; else fail "seed ladder: $(printf '%s' "$seed_out" | tail -n 3)"; fi
else
  fail "seed Hub on SQLite never listened"; tail -n 20 "$WORK/seed-hub.log" || true
fi
kill -TERM "$seed_pid" 2>/dev/null || true
wait "$seed_pid" 2>/dev/null || true
# A stopped Hub normally leaves its -wal behind (recent writes live there);
# the tool must include it, which the "replied task" check below proves.
if [ -s "$SEED-wal" ]; then echo "INFO migrate: stopped seed Hub left a $(stat -c %s "$SEED-wal")-byte -wal"; fi

expect_refusal() {
  local label=$1 pattern=$2; shift 2
  local out rc=0
  out="$("${MIGRATE[@]}" "$@" 2>&1)" || rc=$?
  if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q -- "$pattern"; then pass "$label (rc=2)"
  else fail "$label: rc=$rc out=$(printf '%s' "$out" | tail -n 2)"; fi
  if printf '%s' "$out" | grep -q "$LADDER_PW"; then fail "$label: password printed"; fi
}

# ── refusals ──
LIVE_DIR="$WORK/livecase"; mkdir -p "$LIVE_DIR"; cp "$SEED"* "$LIVE_DIR/"
env -u DATABASE_URL -u COMMHUB_PG_EXPERIMENTAL COMMHUB_DB="$LIVE_DIR/commhub.db" PORT=29216 HOST=127.0.0.1 \
  bun src/index.ts >"$WORK/live-hub.log" 2>&1 &
live_pid=$!
if wait_health 29216 "$live_pid"; then
  expect_refusal "a database open in a running Hub is refused" "open in running process" --from "$LIVE_DIR/commhub.db" --to "$(url mig_dry)" --dry-run
else
  fail "live-case Hub never listened"
fi
kill -TERM "$live_pid" 2>/dev/null || true
wait "$live_pid" 2>/dev/null || true
mkdir -p "$HOME/.commhub"; cp "$SEED"* "$HOME/.commhub/"
expect_refusal "source under ~/.commhub is refused" "live Hub's directory" --from "$HOME/.commhub/commhub.db" --to "$(url mig_dry)" --dry-run
expect_refusal "non-empty target is refused" 'target schema "public" is not empty' --from "$SEED" --to "$(url mig_nonempty)"
[ "$(public_objects mig_dry)" = 0 ] && pass "refusals left the target untouched" || fail "refusals touched mig_dry"

# ── --i-know-this-is-a-copy + dry run ──
rc=0; out="$("${MIGRATE[@]}" --from "$HOME/.commhub/commhub.db" --to "$(url mig_dry)" --dry-run --i-know-this-is-a-copy 2>&1)" || rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'SUMMARY result=DRY-RUN .*verify=OK'; then pass "dry run with --i-know-this-is-a-copy verified every table"; else fail "dry run: rc=$rc $(printf '%s' "$out" | tail -n 3)"; fi
[ "$(public_objects mig_dry)" = 0 ] && pass "dry run left the target empty" || fail "dry run left objects in mig_dry"

# ── tamper: a copy of the tool that alters one value must fail verification ──
cp src/migrate-sqlite-to-pg.ts src/migrate-tamper.ts
sed -i 's|^  return value;$|  return value === "ladder-pong" ? "tampered" : value;|' src/migrate-tamper.ts
if ! grep -q '"tampered"' src/migrate-tamper.ts; then fail "tamper mutation did not apply"; fi
rc=0; out="$(bun -e "
  const m = await import('/work/server/src/migrate-tamper.ts');
  try { await m.migrateSqliteToPg({ from: process.argv[1], to: process.argv[2], log: (l) => { if (l.includes('SUMMARY')) console.log(l); } }); process.exit(0); }
  catch (e) { console.error(String(e.message)); process.exit(1); }" "$SEED" "$(url mig_tamper)" 2>&1)" || rc=$?
rm -f src/migrate-tamper.ts
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'verification failed for ' && printf '%s' "$out" | grep -q 'SUMMARY result=FAILED .*verify=MISMATCH'; then
  pass "tampered copy fails verification with a non-zero rc and a MISMATCH summary (MUTATION_RED)"
else fail "tamper: rc=$rc $(printf '%s' "$out" | tail -n 2)"; fi
[ "$(public_objects mig_tamper)" = 0 ] && pass "failed migration rolled back and left the target empty" || fail "failed migration left objects in mig_tamper"
# The same target, after that failure, takes a clean migration — and every
# user trigger there is enabled (none left disabled by the failed run).
rc=0; out="$("${MIGRATE[@]}" --from "$SEED" --to "$(url mig_tamper)" 2>&1)" || rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'SUMMARY result=COMMITTED .*verify=OK'; then pass "the target of a failed migration accepts a clean one"; else fail "re-migrate after failure: rc=$rc $(printf '%s' "$out" | tail -n 2)"; fi
user_triggers="$(psql_admin -d mig_tamper -Atc "SELECT COUNT(*) FROM pg_trigger WHERE NOT tgisinternal")"
disabled_triggers="$(psql_admin -d mig_tamper -Atc "SELECT COUNT(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O'")"
if [ "$user_triggers" -ge 2 ] && [ "$disabled_triggers" = 0 ]; then pass "after the failed run, all $user_triggers user triggers are enabled"; else fail "triggers after failed run: total=$user_triggers disabled=$disabled_triggers"; fi

# ── the real migration ──
rc=0; out="$("${MIGRATE[@]}" --from "$SEED" --to "$(url mig_target)" 2>&1)" || rc=$?
printf '%s\n' "$out" | grep -E 'SUMMARY|FAILED|REFUSING' || true
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'SUMMARY result=COMMITTED .*verify=OK'; then pass "migration committed (summary verify=OK, rc=0)"; else fail "migration rc=$rc $(printf '%s' "$out" | tail -n 3)"; fi
events_before="$(psql_admin -d mig_target -Atc "SELECT COUNT(*) FROM task_terminal_events")"
replied="$(psql_admin -d mig_target -Atc "SELECT COUNT(*) FROM tasks WHERE content = 'ladder-ping' AND status = 'replied' AND result = 'ladder-pong'")"
[ "$replied" = 1 ] && pass "the seeded, replied task is in PostgreSQL" || fail "seeded task rows found: $replied"

# ── the Hub on the migrated data ──
env -u COMMHUB_DB COMMHUB_PG_EXPERIMENTAL=1 DATABASE_URL="$(url mig_target)" PORT=29215 HOST=127.0.0.1 \
  bun src/index.ts >"$WORK/migrated-hub.log" 2>&1 &
mig_pid=$!
if wait_health 29215 "$mig_pid"; then
  mig_out="$(LADDER_EXISTING_ADMIN=1 LADDER_NET_NAME=pg-ladder-after-migrate bun "$SUITE_DIR/ladder.ts" http://127.0.0.1:29215 2>&1 || true)"
  printf '%s\n' "$mig_out" | grep -E '^(PASS|FAIL) L' || true
  if printf '%s\n' "$mig_out" | grep -qx 'LADDER_LEVEL=5'; then pass "Hub on the migrated PostgreSQL reached L5"; else fail "migrated ladder stopped early"; fi
  events_after="$(psql_admin -d mig_target -Atc "SELECT COUNT(*) FROM task_terminal_events")"
  if [ "$events_after" -gt "$events_before" ]; then pass "terminal events keep being recorded on the migrated database ($events_before → $events_after)"; else fail "terminal events did not grow ($events_before → $events_after)"; fi
else
  fail "Hub on the migrated PostgreSQL never listened"; tail -n 20 "$WORK/migrated-hub.log" || true
fi
kill -TERM "$mig_pid" 2>/dev/null || true
wait "$mig_pid" 2>/dev/null || true

echo "MIGRATE_FAILED=$fails"
[ "$fails" -eq 0 ]
