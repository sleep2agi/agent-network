#!/usr/bin/env bash
set -euo pipefail
umask 077

MODE=${TEST232_MODE:-enabled}
case "$MODE" in enabled|restricted) ;; *) echo "FAIL: invalid TEST232_MODE" >&2; exit 2;; esac

REAL_GROK=${TEST232_REAL_GROK_BIN:-/host-grok/grok-0.2.93}
REAL_AUTH=${TEST232_REAL_GROK_AUTH:-/host-grok/auth.json}
ARTIFACT_DIR=${ARTIFACT_DIR:-/artifacts}
REPORT="$ARTIFACT_DIR/report-test232-grok-xsearch-process-profile-${MODE}.txt"
ROOT=/tmp/test232
HOME_DIR="$ROOT/home"
GROK_HOME_DIR="$HOME_DIR/.grok"
WORK="$ROOT/work"
OUTPUT="$ROOT/stream.jsonl"
EVIDENCE="$ROOT/evidence.json"

rm -rf "$ROOT"
mkdir -p "$GROK_HOME_DIR" "$WORK" "$ARTIFACT_DIR"
cp "$REAL_AUTH" "$GROK_HOME_DIR/auth.json"
printf '%s\n' '[toolset.bash]' 'auto_background_on_timeout = false' >"$GROK_HOME_DIR/config.toml"
printf '%s\n' \
  '---' \
  'name: anet-xsearch-probe' \
  'description: Exact process-level X web search probe' \
  'injectDefaultTools: false' \
  'discoverSkills: false' \
  'inheritSkills: false' \
  'tools:' \
  '  - web_search' \
  '---' \
  'Use only web_search. Never guess a URL.' >"$GROK_HOME_DIR/xsearch.md"
chown -R 1000:1000 "$ROOT"
chmod 700 "$ROOT" "$HOME_DIR" "$GROK_HOME_DIR" "$WORK"
chmod 600 "$GROK_HOME_DIR"/*

: >"$REPORT"
chmod 600 "$REPORT"
chown 1000:1000 "$REPORT"
log() { printf '%s\n' "$*" | tee -a "$REPORT"; }
fail() { log "FAIL: $*"; exit 1; }

log '# test232 — process-level Grok X-search capability'
log "mode=$MODE"
log "grok_binary_sha256=$(sha256sum "$REAL_GROK" | awk '{print $1}')"

ARGS=(
  --single 'Find one recent public X post from @xai and return its x.com URL. Use web_search with allowed_domains x.com; do not guess.'
  --cwd "$WORK"
  --output-format streaming-json
  --agent "$GROK_HOME_DIR/xsearch.md"
  --permission-mode bypassPermissions
  --always-approve
  --sandbox workspace
  --no-subagents
  --no-memory
  --deny Bash
  --deny Write
  --deny WebFetch
)
TIMEOUT=150
if [ "$MODE" = restricted ]; then
  ARGS+=(--disable-web-search)
  TIMEOUT=45
fi

set +e
setpriv --reuid=1000 --regid=1000 --clear-groups \
  env -i HOME="$HOME_DIR" GROK_HOME="$GROK_HOME_DIR" \
  PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 \
  timeout "$TIMEOUT" "$REAL_GROK" "${ARGS[@]}" >"$OUTPUT" 2>&1
RC=$?
set -e

bun /test232/read-evidence.ts "$GROK_HOME_DIR" "$OUTPUT" >"$EVIDENCE"
WEB_CALLS=$(bun -e 'const x=await Bun.file(process.argv[1]).json(); console.log(x.webSearchCalls)' "$EVIDENCE")
ALLOWED_X=$(bun -e 'const x=await Bun.file(process.argv[1]).json(); console.log(x.allowedX)' "$EVIDENCE")
URL_COUNT=$(bun -e 'const x=await Bun.file(process.argv[1]).json(); console.log(x.xStatusUrls.length)' "$EVIDENCE")
ENDED=$(bun -e 'const x=await Bun.file(process.argv[1]).json(); console.log(x.ended)' "$EVIDENCE")
log "process_rc=$RC"
log "ended=$ENDED"
log "web_search_calls=$WEB_CALLS"
log "allowed_domains_x=$ALLOWED_X"
log "x_status_url_count=$URL_COUNT"

if [ "$MODE" = enabled ]; then
  [ "$RC" -eq 0 ] || fail "enabled process did not complete"
  [ "$ENDED" = true ] || fail "enabled process lacked terminal event"
  [ "$WEB_CALLS" -gt 0 ] || fail "enabled process did not call web_search"
  [ "$URL_COUNT" -gt 0 ] || fail "enabled process returned no x.com status URL"
  FIRST_URL=$(bun -e 'const x=await Bun.file(process.argv[1]).json(); process.stdout.write(x.xStatusUrls[0])' "$EVIDENCE")
  HTTP_CODE=$(curl -L -sS -o /dev/null -w '%{http_code}' --max-time 20 "$FIRST_URL")
  [[ "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]] || fail "returned X status URL did not resolve successfully"
  log "x_status_url_http=$HTTP_CODE"
  if [ "$ALLOWED_X" != true ]; then
    log "LIMITATION: Grok used general web_search rather than allowed_domains=[x.com]"
  fi
else
  [ "$WEB_CALLS" -eq 0 ] || fail "restricted process called web_search"
  [ "$URL_COUNT" -eq 0 ] || fail "restricted process returned an unverified x.com status URL"
fi

# Neither the secret-bearing auth file nor raw model output is copied to the
# artifact mount. Reports contain capability counters only.
log "Summary: PASS (mode=$MODE; Docker-only; exact process-level capability difference)"
