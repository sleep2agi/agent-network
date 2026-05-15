#!/bin/sh
# Issue #115 functional test on obfuscated dist.
#
# Verifies, in a clean container, that:
#   1. anet --help advertises --resume / --resume-latest
#   2. anet session ls (refactored to listClaudeSessions) still works
#   3. node create --resume <id>   binds the chosen session
#   4. node create --resume <bad>  fails fast
#   5. node create --resume-latest binds the newest session
#   6. node create with neither flag (non-TTY) writes a fresh UUID
#   7. node create --resume <id> --resume-latest  is rejected
#   8. node start spawns claude with CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999
set -eu
ANET="node /anet/dist/bin/cli.js"
PASS=0; FAIL=0
PROJECT_KEY=$(echo "$PWD" | sed 's|/|-|g')   # /work → -work
PROJ_DIR="$HOME/.claude/projects/$PROJECT_KEY"
SESS_OLD="aaaaaaaa-1111-2222-3333-444444444444"
SESS_NEW="bbbbbbbb-1111-2222-3333-444444444444"

ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

# ── Fixtures ────────────────────────────────────────────────────────────
echo "── Setup ──"
mkdir -p "$PROJ_DIR" "$HOME/.anet" "$HOME/bin"

# Old session: first line is a user message → preview should show its text.
cat > "$PROJ_DIR/$SESS_OLD.jsonl" <<'JSONL'
{"type":"user","message":{"content":"Refactor launchAgent for #115 resume picker"},"timestamp":"2026-05-14T01:00:00Z"}
{"type":"assistant","message":{"content":"OK"},"timestamp":"2026-05-14T01:00:01Z"}
JSONL

# New session: starts with a summary entry → preview should be the summary text.
cat > "$PROJ_DIR/$SESS_NEW.jsonl" <<'JSONL'
{"type":"summary","summary":"Issue 93 batch alias fix verified"}
{"type":"user","message":{"content":"ack"},"timestamp":"2026-05-15T02:00:00Z"}
JSONL

touch -d "2026-05-14 01:00" "$PROJ_DIR/$SESS_OLD.jsonl"
touch -d "2026-05-15 02:00" "$PROJ_DIR/$SESS_NEW.jsonl"

# Global config — bypasses hub probe, vendor selector, network picker.
cat > "$HOME/.anet/config.json" <<JSON
{"hub":"http://127.0.0.1:9477","token":"utok_test_admin","network_id":"net_test","network_name":"test"}
JSON

# `claude` shim — supports --help (so claudeSupportsSessionId picks the
# session-id path) and echoes the env var when invoked as a child.
cat > "$HOME/bin/claude" <<'SH'
#!/bin/sh
case "$1" in
  --help) echo "Claude Code shim --session-id <uuid> --resume <uuid>"; exit 0;;
  --version) echo "shim-9.9.9"; exit 0;;
esac
echo "CLAUDE_SHIM_INVOKED RESUME_THRESHOLD=${CLAUDE_CODE_RESUME_THRESHOLD_MINUTES:-UNSET}"
echo "CLAUDE_SHIM_ARGS $*"
exit 0
SH
chmod +x "$HOME/bin/claude"
export PATH="$HOME/bin:$PATH"

# Mock hub: only /api/auth/node-token is needed. Backgrounded; killed at exit.
node - <<'JS' &
const http = require("http");
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    if (req.url === "/api/auth/node-token" && req.method === "POST") {
      res.writeHead(200, {"content-type":"application/json"});
      res.end(JSON.stringify({ ok:true, token:"ntok_test_" + Date.now() }));
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, {"content-type":"application/json"});
      res.end(JSON.stringify({ ok:true, version:"mock", sessions_count:0 }));
      return;
    }
    res.writeHead(404); res.end();
  });
});
srv.listen(9477, "127.0.0.1");
JS
HUB_PID=$!
trap "kill $HUB_PID 2>/dev/null || true" EXIT
sleep 0.5

echo
# ── 1. help text ───────────────────────────────────────────────────────
echo "── Test 1: --help advertises new flags ──"
H=$($ANET --help 2>&1)
echo "$H" | grep -q -- "--resume <id>"      && ok "help: --resume <id>"      || bad "help: --resume <id> missing"
echo "$H" | grep -q -- "--resume-latest"    && ok "help: --resume-latest"    || bad "help: --resume-latest missing"

# ── 2. session ls (refactor) ───────────────────────────────────────────
echo "── Test 2: anet session ls ──"
S=$($ANET session ls 2>&1)
echo "$S" | grep -q "$SESS_OLD" && echo "$S" | grep -q "$SESS_NEW" && ok "session ls lists both" || bad "session ls missing one of the fixtures: $S"
# Newest first: SESS_NEW line must appear before SESS_OLD line.
NEW_LINE=$(echo "$S" | grep -n "$SESS_NEW" | cut -d: -f1)
OLD_LINE=$(echo "$S" | grep -n "$SESS_OLD" | cut -d: -f1)
[ "$NEW_LINE" -lt "$OLD_LINE" ] && ok "session ls newest-first ordering" || bad "ordering wrong (new=$NEW_LINE old=$OLD_LINE)"

# ── 3. --resume <good-id> binds ────────────────────────────────────────
echo "── Test 3: node create --resume <good> ──"
$ANET node create t1 --runtime claude-code-cli --resume "$SESS_OLD" </dev/null >/tmp/t1.log 2>&1
BOUND=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.anet/nodes/t1/config.json')).session)")
[ "$BOUND" = "$SESS_OLD" ] && ok "t1 bound to $SESS_OLD" || bad "t1 session=$BOUND expected $SESS_OLD"

# ── 4. --resume <bad-id> rejects ───────────────────────────────────────
echo "── Test 4: node create --resume <bad> ──"
if $ANET node create t2 --runtime claude-code-cli --resume "nope-0000-0000-0000-000000000000" </dev/null >/tmp/t2.log 2>&1; then
  bad "t2 should have failed but succeeded"
else
  grep -q "不在当前目录的 Claude project" /tmp/t2.log && ok "t2 rejected with helpful error" || bad "t2 failed but error message wrong: $(cat /tmp/t2.log)"
fi
[ ! -f .anet/nodes/t2/config.json ] && ok "t2 config not written" || bad "t2 config leaked on rejected create"

# ── 5. --resume-latest binds newest ────────────────────────────────────
echo "── Test 5: node create --resume-latest ──"
$ANET node create t3 --runtime claude-code-cli --resume-latest </dev/null >/tmp/t3.log 2>&1
BOUND3=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.anet/nodes/t3/config.json')).session)")
[ "$BOUND3" = "$SESS_NEW" ] && ok "t3 bound to newest ($SESS_NEW)" || bad "t3 session=$BOUND3 expected $SESS_NEW"

# ── 6. no flag, non-TTY → fresh UUID ───────────────────────────────────
echo "── Test 6: node create (no flag, non-TTY) ──"
$ANET node create t4 --runtime claude-code-cli </dev/null >/tmp/t4.log 2>&1
BOUND4=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.anet/nodes/t4/config.json')).session)")
case "$BOUND4" in
  "$SESS_OLD"|"$SESS_NEW") bad "t4 accidentally bound to an existing session ($BOUND4)" ;;
  "") bad "t4 has no session — expected fresh UUID" ;;
  *) ok "t4 has fresh UUID ($BOUND4)" ;;
esac

# ── 7. --resume + --resume-latest is rejected ──────────────────────────
echo "── Test 7: node create --resume <id> --resume-latest (conflict) ──"
if $ANET node create t5 --runtime claude-code-cli --resume "$SESS_OLD" --resume-latest </dev/null >/tmp/t5.log 2>&1; then
  bad "t5 should have failed but succeeded"
else
  grep -q "不能同时使用" /tmp/t5.log && ok "t5 conflict rejected" || bad "t5 failed but for wrong reason: $(cat /tmp/t5.log)"
fi

# ── 8. node start injects CLAUDE_CODE_RESUME_THRESHOLD_MINUTES ─────────
echo "── Test 8: node start injects env ──"
$ANET node start t1 </dev/null >/tmp/start.log 2>&1 || true
if grep -q "RESUME_THRESHOLD=999999999" /tmp/start.log; then
  ok "env injection present (CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999)"
else
  bad "env injection missing — start.log: $(cat /tmp/start.log)"
fi
# And it should also pass --resume <SESS_OLD> to claude (session file exists).
grep -q "CLAUDE_SHIM_ARGS.*--resume $SESS_OLD" /tmp/start.log \
  && ok "claude invoked with --resume $SESS_OLD" \
  || bad "claude args missing --resume: $(grep CLAUDE_SHIM_ARGS /tmp/start.log)"

echo
echo "──────────────────────────────────────"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "──────────────────────────────────────"
[ "$FAIL" -eq 0 ]
