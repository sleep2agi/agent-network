set -euo pipefail
OLD=/base/node_modules/@sleep2agi/commhub-server/bin/commhub.ts
NEW=/cand/server/bin/commhub.ts
HOME_DIR=$(mktemp -d); DB=$HOME_DIR/hub.db; STATE=$HOME_DIR/state.json; export PREV_CAPS_FILE=$HOME_DIR/caps-old.json
start() { HOME=$HOME_DIR bun "$1" --port 29421 --host 127.0.0.1 --db "$DB" >> "$HOME_DIR/$2.log" 2>&1 & PID=$!
  for _ in $(seq 1 60); do bun -e "fetch('http://127.0.0.1:29421/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null && return 0; kill -0 $PID 2>/dev/null || break; sleep 1; done
  echo "FAIL: $2 did not start"; tail -20 "$HOME_DIR/$2.log"; return 1; }
stop() { kill -TERM $PID; wait $PID || true; }
U=http://127.0.0.1:29421
start "$OLD" v_old_a; bun /compat/upgrade.ts seed $U $STATE; bun /compat/upgrade.ts view $U $STATE > /tmp/old_a.json; stop
start "$NEW" v_new_a; bun /compat/upgrade.ts view $U $STATE > /tmp/new_a.json; stop
grep -E 'backfill|completed_at|migrat' "$HOME_DIR/v_new_a.log" | head -5 || true
start "$OLD" v_old_b; bun /compat/upgrade.ts view $U $STATE > /tmp/old_b.json; stop
start "$NEW" v_new_b; bun /compat/upgrade.ts view $U $STATE > /tmp/new_b.json; bun /compat/upgrade.ts new-member $U $STATE > /tmp/late.json; stop
bun /compat/upgrade-compare.ts
