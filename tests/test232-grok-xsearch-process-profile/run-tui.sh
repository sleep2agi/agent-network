#!/usr/bin/env bash
set -euo pipefail
umask 077

REAL_GROK=${TEST232_REAL_GROK_BIN:-/host-grok/grok-0.2.93}
REAL_AUTH=${TEST232_REAL_GROK_AUTH:-/host-grok/auth.json}
ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test232-grok-xsearch-real-tui.txt"
ROOT=/home/tester
HOME_DIR="$ROOT"
GROK_HOME_DIR="$HOME_DIR/.anet-grok/node-test232"
WORK=/workspace/project
OUTPUT="$ROOT/pty.raw"
EVIDENCE="$ROOT/evidence.json"
SOCKET="$GROK_HOME_DIR/run/leader.sock"
SESSION_ID=23223223-3232-4232-8232-232232232232

rm -rf "$ROOT"
mkdir -p "$GROK_HOME_DIR/run" "$WORK" "$ARTIFACT_DIR" /run/user/1000
cp "$REAL_AUTH" "$GROK_HOME_DIR/auth.json"
printf '%s\n' '[toolset.bash]' 'auto_background_on_timeout = false' >"$GROK_HOME_DIR/config.toml"
printf '%s\n' \
  '---' \
  'name: anet-xsearch-tui-probe' \
  'description: Exact process-level X web search TUI probe' \
  'injectDefaultTools: false' \
  'discoverSkills: false' \
  'inheritSkills: false' \
  'tools:' \
  '  - web_search' \
  '---' \
  'Use only web_search. Never guess a URL.' >"$GROK_HOME_DIR/xsearch.md"
chown -R 1000:1000 "$ROOT" "$WORK"
chown 1000:1000 /run/user/1000
chmod 700 "$ROOT" "$GROK_HOME_DIR" "$GROK_HOME_DIR/run" "$WORK" /run/user/1000
find "$GROK_HOME_DIR" -maxdepth 1 -type f -exec chmod 600 {} +

: >"$REPORT"
chmod 600 "$REPORT"
chown 1000:1000 "$REPORT"
log() { printf '%s\n' "$*" | tee -a "$REPORT"; }
fail() { log "FAIL: $*"; exit 1; }

log '# test232 — real interactive Grok TUI X search'
log "grok_binary_sha256=$(sha256sum "$REAL_GROK" | awk '{print $1}')"

set +e
python3 /test232/pty-run.py --timeout 150 --output "$OUTPUT" \
  --send 'Find one recent public X post from @xai and return its x.com URL. Use web_search; do not guess.' -- \
  setpriv --reuid=1000 --regid=1000 --clear-groups \
  env -i HOME="$HOME_DIR" GROK_HOME="$GROK_HOME_DIR" \
  XDG_RUNTIME_DIR=/run/user/1000 \
  GROK_AUTH_PATH="$GROK_HOME_DIR/auth.json" GROK_FOLDER_TRUST=1 \
  PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 \
  "$REAL_GROK" \
  --leader --leader-socket "$SOCKET" \
  --cwd "$WORK" --session-id "$SESSION_ID" \
  --agent "$GROK_HOME_DIR/xsearch.md" \
  --permission-mode bypassPermissions --always-approve \
  --sandbox workspace --no-auto-update --no-subagents --no-memory \
  --deny Bash --deny Write --deny WebFetch --no-alt-screen
RC=$?
set -e

bun /test232/read-evidence.ts "$GROK_HOME_DIR" "$OUTPUT" >"$EVIDENCE"
WEB_CALLS=$(bun -e 'const x=await Bun.file(process.argv[1]).json(); console.log(x.webSearchCalls)' "$EVIDENCE")
URL_COUNT=$(bun -e 'const x=await Bun.file(process.argv[1]).json(); console.log(x.xStatusUrls.length)' "$EVIDENCE")
FIRST_URL=$(bun -e 'const x=await Bun.file(process.argv[1]).json(); process.stdout.write(x.xStatusUrls[0]||"")' "$EVIDENCE")
log "bounded_pty_rc=$RC"
log "web_search_calls=$WEB_CALLS"
log "x_status_url_count=$URL_COUNT"
[ "$WEB_CALLS" -gt 0 ] || fail "interactive TUI did not call web_search"
[ "$URL_COUNT" -gt 0 ] || fail "interactive TUI returned no X status URL"
HTTP_CODE=$(curl -L -sS -o /dev/null -w '%{http_code}' --max-time 20 "$FIRST_URL")
[[ "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]] || fail "interactive TUI returned an invalid X status URL"
log "x_status_url_http=$HTTP_CODE"
log 'Summary: PASS (real interactive TUI; exact web_search profile; Docker-only)'
