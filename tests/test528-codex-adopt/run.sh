#!/usr/bin/env bash
# test528-codex-adopt — `anet node codex adopt` turns a codex conversation started outside anet into a node (#528).
#
# Real CLI (agent-network/bin/cli.ts) × real Hub (server/src/index.ts) on a random port, HOME=$(mktemp -d).
# The source is a fixture CODEX_HOME (not ~/.codex) with 3 synthetic rollouts: A and B share a 35-char
# prefix, C stands alone; plus a placeholder auth.json, config.toml trusting A's cwd, and AGENTS.md.
# No codex binary, no login, no tmux. Cases:
#   L  non-TTY, no --thread  → rc 2, prints the three conversations + usage, creates nothing
#   F  --thread <full id A>  → rc 0; the node has exactly one rollout, ids + cwd rewritten,
#                              no auth.json, trusted project rewritten, Hub row present, login command printed
#   P  --thread <unique prefix of C> → rc 0, the rollout is C's
#   X  --thread <prefix shared by A and B> → rc 2 "matches 2 conversations", creates nothing
#   T  TTY, no --thread, answer "3" (newest first → A) → rc 0
#   S  the source home is byte-identical (content, size, mtime, mode) before and after all of the above
# M1–M5 are witnessed reds (M3 is caught only by S: content-identical, mtime moves), one per rule; a mutation that does not apply fails (MUTATION_NOOP).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/safe-rm.sh"

ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test528-codex-adopt.txt"
mkdir -p "$ARTIFACT_DIR"
: > "$REPORT"
exec > >(tee -a "$REPORT") 2>&1

echo "# test528-codex-adopt — adopt an external codex conversation as a node"
echo "source_commit=${TEST528_SOURCE_COMMIT:-unknown}"
echo "date=$(date -Is)"

ROOT=/workspace
CLI="$ROOT/agent-network/bin/cli.ts"
HUB_PID=""
A=01a02193-e1fd-70f3-9e16-6fbff295fbae
B=01a02193-e1fd-70f3-9e16-6fbff295fbaf
C=01b0cccc-0000-7000-8000-000000000003

anet() { bun "$CLI" "$@"; }

health_ok() { bun -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' "http://127.0.0.1:$PORT/health"; }
free_port() { bun -e 'const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});console.log(s.port);s.stop(true)'; }

start_hub() {
  pushd "$ROOT/server" >/dev/null
  PORT="$PORT" COMMHUB_DB="$HUB_DB" bun src/index.ts >>"$WORK/hub.log" 2>&1 &
  HUB_PID=$!
  popd >/dev/null
  for _ in $(seq 1 100); do
    if health_ok; then return 0; fi
    sleep 0.2
  done
  echo "FAIL: hub did not come up on :$PORT"; tail -50 "$WORK/hub.log"; return 1
}

# Stops exactly the hub this script started (by its pid; never by pattern).
stop_hub() {
  [ -n "$HUB_PID" ] || return 0
  kill "$HUB_PID" 2>/dev/null || true
  wait "$HUB_PID" 2>/dev/null || true
  HUB_PID=""
}

token() { bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.anet/config.json","utf8")).token)'; }
cfg() { bun -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c[process.argv[2]]??"")' "$1/.anet/nodes/$2/config.json" "$3"; }

rows_for() {
  TOKEN=$(token) bun -e '
    const [url, id] = process.argv.slice(1);
    const r = await fetch(`${url}/api/nodes?node_id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${process.env.TOKEN}` } });
    const j = await r.json();
    if (!r.ok || !Array.isArray(j.nodes)) { console.error("rows_for: HTTP", r.status, JSON.stringify(j)); process.exit(1); }
    console.log(j.nodes.filter((n) => n.node_id === id).length);
  ' "http://127.0.0.1:$PORT" "$1"
}

# Fixture CODEX_HOME — compact JSON like codex writes (the cwd rewrite only matches "cwd":"…").
make_source() {
  local h=$1 meta
  mkdir -p "$h/sessions/2026/10/01" "$h/sessions/2026/10/02" "$h/sessions/2026/10/03"
  meta() { printf '{"timestamp":"%s","type":"session_meta","payload":{"id":"%s","session_id":"%s","timestamp":"%s","cwd":"%s"}}' "$2" "$1" "$1" "$2" "$3"; }
  { meta "$A" 2026-10-01T01:00:00.000Z /proj/a; echo
    printf '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}\n'
    printf '{"type":"event_msg","payload":{"type":"user_message","message":"conversation A: fix the flaky test"}}\n'
    printf '{"type":"turn_context","payload":{"cwd":"/proj/a","model":"gpt-5-a","x":"%s"}}\n' "$A"
  } > "$h/sessions/2026/10/01/rollout-2026-10-01T01-00-00-$A.jsonl"
  { meta "$B" 2026-10-02T02:00:00.000Z /proj/b; echo
    printf '{"type":"event_msg","payload":{"type":"user_message","message":"conversation B"}}\n'
  } > "$h/sessions/2026/10/02/rollout-2026-10-02T02-00-00-$B.jsonl"
  { meta "$C" 2026-10-03T03:00:00.000Z /proj/c; echo
    printf '{"type":"event_msg","payload":{"type":"user_message","message":"conversation C: write docs"}}\n'
    printf '{"type":"turn_context","payload":{"cwd":"/proj/c","model":"gpt-5-c"}}\n'
  } > "$h/sessions/2026/10/03/rollout-2026-10-03T03-00-00-$C.jsonl"
  printf '{"auth_mode":"chatgpt","tokens":{"refresh_token":"placeholder-refresh-not-real","access_token":"placeholder"}}\n' > "$h/auth.json"
  chmod 600 "$h/auth.json"
  printf 'model = "gpt-5-a"\n\n[projects."/proj/a"]\ntrust_level = "trusted"\n' > "$h/config.toml"
  printf '# rules\n' > "$h/AGENTS.md"
  # Old mtimes, so any write (even a touch) shows up in the snapshot.
  find "$h" -exec touch -h -d '2026-01-01 00:00:00' {} +
}

snapshot() { (cd "$1" && find . -print0 | sort -z | xargs -0 stat -c '%n %s %Y %a %i' && find . -type f -print0 | sort -z | xargs -0 sha256sum); }

# Asserts on one adopted node: exactly one rollout, ids + cwd rewritten, no auth.json.
check_node() {
  local wd=$1 name=$2 src_id=$3 src_cwd=$4 marker=$5 nh n thread first
  nh="$wd/.anet/nodes/$name/codex-home"
  [ -d "$nh" ] || { echo "FAIL: $name has no codex-home"; return 1; }
  n=$(find "$nh/sessions" -type f -name 'rollout-*.jsonl' | wc -l)
  [ "$n" = 1 ] || { echo "FAIL: $name has $n rollout file(s), want exactly 1"; return 1; }
  first=$(find "$nh/sessions" -type f -name 'rollout-*.jsonl')
  thread=$(cfg "$wd" "$name" codexThreadId)
  [[ "$thread" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || { echo "FAIL: $name codexThreadId '$thread' is not a v7 uuid"; return 1; }
  [ "$thread" != "$src_id" ] || { echo "FAIL: $name kept the source thread id"; return 1; }
  [[ "$first" == *"-$thread.jsonl" ]] || { echo "FAIL: $name rollout file not named for its thread: $first"; return 1; }
  ! grep -Fq "$src_id" "$first" || { echo "FAIL: $name rollout still carries the source thread id"; return 1; }
  [ "$(bun -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n")[0];console.log(JSON.parse(l).payload.session_id)' "$first")" = "$thread" ] || { echo "FAIL: $name session_meta not rewritten"; return 1; }
  ! grep -Fq "\"cwd\":\"$src_cwd\"" "$first" || { echo "FAIL: $name rollout still records cwd $src_cwd"; return 1; }
  grep -Fq "\"cwd\":\"$wd\"" "$first" || { echo "FAIL: $name rollout does not record cwd $wd"; return 1; }
  grep -Fq "$marker" "$first" || { echo "FAIL: $name rollout is not the chosen conversation ($marker)"; return 1; }
  [ ! -e "$nh/auth.json" ] || { echo "FAIL: $name got a copy of the source auth.json"; return 1; }
  [ "$(cfg "$wd" "$name" codexProjectDir)" = "$wd" ] || { echo "FAIL: $name codexProjectDir"; return 1; }
  [ "$(rows_for "$(cfg "$wd" "$name" node_id)")" = 1 ] || { echo "FAIL: $name has no Hub row"; return 1; }
}

run_cases() {
  WORK=$(mktemp -d)
  export HOME="$WORK/home"; mkdir -p "$HOME" "$WORK/proj"
  cd "$WORK/proj"
  PORT=$(free_port)
  HUB_DB="$WORK/hub.db"
  start_hub || return 1
  local hub="http://127.0.0.1:$PORT" out rc src="$WORK/src-codex" wa wp wt
  make_source "$src"
  snapshot "$src" > "$WORK/before.txt"

  anet register --hub "$hub" --username t528 --password 't528-password-xyz' >"$WORK/register.log" 2>&1 || { cat "$WORK/register.log"; echo "FAIL: register"; return 1; }
  anet login --hub "$hub" --username t528 --password 't528-password-xyz' >"$WORK/login.log" 2>&1 || { cat "$WORK/login.log"; echo "FAIL: login"; return 1; }

  echo "  [L] non-TTY without --thread lists and exits non-zero"
  rc=0; out=$(anet node codex adopt l1 --from-home "$src" </dev/null 2>&1) || rc=$?
  echo "$out" | sed 's/^/      /'
  [ "$rc" -eq 2 ] || { echo "FAIL: L rc=$rc (want 2)"; return 1; }
  printf '%s\n' "$out" | grep -Fq -- '--thread is required' || { echo "FAIL: L no --thread hint"; return 1; }
  printf '%s\n' "$out" | grep -Fq 'Usage: anet node codex adopt' || { echo "FAIL: L no usage"; return 1; }
  printf '%s\n' "$out" | grep -Eq '^ +1\. 2026-10-03 03:00:00Z  01b0cccc  /proj/c  "conversation C: write docs"$' || { echo "FAIL: L row 1 is not C (newest first, short id, cwd, prompt)"; return 1; }
  printf '%s\n' "$out" | grep -Fq "$A" && printf '%s\n' "$out" | grep -Fq "$B" || { echo "FAIL: L A/B not listed with distinguishing ids"; return 1; }
  [ ! -e "$WORK/proj/.anet/nodes/l1" ] || { echo "FAIL: L created a node"; return 1; }
  echo "  PASS L"

  echo "  [F] adopt by full id"
  wa="$WORK/wa"
  rc=0; out=$(anet node codex adopt n-full --thread "$A" --from-home "$src" --workdir "$wa" 2>&1) || rc=$?
  echo "$out" | sed 's/^/      /'
  [ "$rc" -eq 0 ] || { echo "FAIL: F rc=$rc"; return 1; }
  wa=$(realpath "$wa")
  check_node "$wa" n-full "$A" /proj/a "conversation A: fix the flaky test" || return 1
  printf '%s\n' "$out" | grep -Fxq "    CODEX_HOME=$wa/.anet/nodes/n-full/codex-home codex login --device-auth" || { echo "FAIL: F did not print the node's own login command"; return 1; }
  grep -Fq "[projects.\"$wa\"]" "$wa/.anet/nodes/n-full/codex-home/config.toml" || { echo "FAIL: F trusted project not rewritten"; return 1; }
  [ -e "$wa/.anet/nodes/n-full/codex-home/AGENTS.md" ] || { echo "FAIL: F AGENTS.md not carried"; return 1; }
  [ "$(cfg "$wa" n-full model)" = "gpt-5-a" ] || { echo "FAIL: F model is not the conversation's last model"; return 1; }
  echo "  PASS F"

  echo "  [P] adopt by unique prefix"
  wp="$WORK/wp"
  rc=0; out=$(anet node codex adopt n-pre --thread 01b0 --from-home "$src" --workdir "$wp" 2>&1) || rc=$?
  echo "$out" | sed 's/^/      /'
  [ "$rc" -eq 0 ] || { echo "FAIL: P rc=$rc"; return 1; }
  check_node "$(realpath "$wp")" n-pre "$C" /proj/c "conversation C: write docs" || return 1
  echo "  PASS P"

  echo "  [X] ambiguous prefix is refused"
  rc=0; out=$(anet node codex adopt n-amb --thread 01a02193 --from-home "$src" --workdir "$WORK/wx" 2>&1) || rc=$?
  echo "$out" | sed 's/^/      /'
  [ "$rc" -eq 2 ] || { echo "FAIL: X rc=$rc (want 2)"; return 1; }
  printf '%s\n' "$out" | grep -Fq 'matches 2 conversations' || { echo "FAIL: X no clear refusal"; return 1; }
  [ ! -e "$WORK/wx/.anet/nodes/n-amb" ] || { echo "FAIL: X created a node"; return 1; }
  echo "  PASS X"

  echo "  [T] TTY picker: answer 3 (newest first → A)"
  wt="$WORK/wt"; mkdir -p "$wt"
  rc=0; out=$(printf '3\n' | script -qec "bun '$CLI' node codex adopt n-tty --from-home '$src' --workdir '$wt'" /dev/null 2>&1) || rc=$?
  echo "$out" | sed 's/^/      /'
  [ "$rc" -eq 0 ] || { echo "FAIL: T rc=$rc"; return 1; }
  check_node "$(realpath "$wt")" n-tty "$A" /proj/a "conversation A: fix the flaky test" || return 1
  echo "  PASS T"

  echo "  [S] the source home is untouched"
  snapshot "$src" > "$WORK/after.txt"
  diff "$WORK/before.txt" "$WORK/after.txt" || { echo "FAIL: S source CODEX_HOME changed"; return 1; }
  echo "  PASS S ($(wc -l < "$WORK/before.txt") entries identical)"

  stop_hub || true
  cd /; safe_rm_rf "$WORK"
  return 0
}

echo "L0 green: real CLI x real hub"
run_cases || { echo "FAIL: L0 not green"; stop_hub || true; exit 1; }

check_red() {
  local label=$1 file=$2 backup=$3
  if cmp -s "$file" "$backup"; then
    echo "MUTATION_NOOP: $label (anchor not found in $file)"
    exit 1
  fi
  local rc=0
  run_cases > "/tmp/test528-$label.log" 2>&1 || rc=$?
  stop_hub || true
  cd "$ROOT/agent-network"
  cp "$backup" "$file"
  if [ "$rc" -eq 0 ]; then
    echo "MUTATION_FALSE_GREEN: $label"
    exit 1
  fi
  echo "MUTATION_RED: $label ($(grep -m1 '^FAIL' "/tmp/test528-$label.log" || echo 'no FAIL line'))"
}

cd "$ROOT/agent-network"
cp bin/cli.ts /tmp/test528-cli.ts
cp src/codex-adopt.ts /tmp/test528-adopt.ts

echo "M1 witnessed-red (F): the source auth.json is copied by default"
sed -i 's|if (f.name === "auth.json" && !allowShared) continue; // #514: never by default|void 0;|' bin/cli.ts
check_red copies-login bin/cli.ts /tmp/test528-cli.ts

echo "M2 witnessed-red (X): an ambiguous prefix takes the first match"
sed -i 's|if (ids.size > 1) return { kind: "ambiguous", matches };|if (ids.size > 1) return { kind: "ok", thread: matches\[0\] };|' src/codex-adopt.ts
check_red first-match src/codex-adopt.ts /tmp/test528-adopt.ts

echo "M3 witnessed-red (S): the source rollout is rewritten in place (same bytes, new mtime)"
sed -i 's|thread.cwd ? { from: thread.cwd, to: workdir } : undefined);$|& writeFileSync(thread.path, readFileSync(thread.path));|' bin/cli.ts
check_red rewrites-source bin/cli.ts /tmp/test528-cli.ts

echo "M4 witnessed-red (F): the recorded cwd is not rewritten"
sed -i 's|thread.cwd ? { from: thread.cwd, to: workdir } : undefined);$|undefined);|' bin/cli.ts
check_red keeps-cwd bin/cli.ts /tmp/test528-cli.ts

echo "M5 witnessed-red (L): without a TTY it prompts anyway"
sed -i 's|    if (!(process.stdin.isTTY && process.stdout.isTTY)) {|    if (false) {|' bin/cli.ts
check_red prompts-without-tty bin/cli.ts /tmp/test528-cli.ts

echo "L1 restored green"
run_cases || { echo "FAIL: restore not green"; stop_hub || true; exit 1; }

echo "RESULT: PASS"
