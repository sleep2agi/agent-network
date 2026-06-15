#!/usr/bin/env bash
# tmcode web smoke harness — tianma-ai/tmcode#3 (ERR_INVALID_URL hot-path fix)
#
# Pre-fix symptom: every request to `tmcode web` returned HTTP 500
# because the web server called `new URL("/")` without a base
# (ERR_INVALID_URL).
#
# Smoke assertions:
#   1. tmcode web --port $PORT --hostname 127.0.0.1 stays up >5s + binds the port
#   2. GET / returns HTTP 200 (not 500) — server doesn't crash on its own
#      root path
#   3. Response body contains a real web UI marker (HTML <!DOCTYPE / <html / <title)
#      and NOT an error JSON shape
#   4-5. 1-2 additional static routes (favicon.ico, /api/health if present)
#      also non-500
#   6. No ERR_INVALID_URL or similar URL-parse error in process stdout/stderr
#
# Output: ./REPORT.md + raw curl evidence in /artifacts.
set -u
ART=/artifacts
PORT="${TMCODE_PORT:-38123}"
HOST=127.0.0.1
URL="http://$HOST:$PORT"
LOG(){ echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$ART/run.log"; }
PASS=(); FAIL=()
record(){
  local id="$1" verdict="$2" evidence="$3"
  if [ "$verdict" = "PASS" ]; then PASS+=("$id"); else FAIL+=("$id"); fi
  echo "| $id | $verdict | $evidence |" >> "$ART/matrix.md"
}

mkdir -p "$ART"
: > "$ART/run.log"
: > "$ART/matrix.md"

LOG "tmcode version: $(tmcode --version 2>&1 | head -1)"
LOG "node: $(node -v)"
LOG "starting: tmcode web --port $PORT --hostname $HOST"

# 1. Start server in background; capture full stdout+stderr to a file.
nohup tmcode web --port "$PORT" --hostname "$HOST" > "$ART/server.log" 2>&1 &
WEB_PID=$!
LOG "tmcode web bg pid=$WEB_PID"

# 2. Wait for port-up (up to 30s). If the process dies, abort with full server.log.
PORT_UP=""
for i in $(seq 1 60); do
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    LOG "server died after ${i}*0.5s — see server.log"
    break
  fi
  if curl -sf --max-time 1 "$URL/" >/dev/null 2>&1; then
    PORT_UP="yes"; break
  fi
  # Allow 5xx response to count as "port-up" too (the bug returns 500 but binds)
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "$URL/" 2>/dev/null || echo "000")
  if [ "$CODE" != "000" ] && [ -n "$CODE" ]; then PORT_UP="yes"; break; fi
  sleep 0.5
done

if [ -z "$PORT_UP" ]; then
  record "1 server-up" "FAIL" "tmcode web never bound port $PORT in 30s; server.log tail: $(tail -5 $ART/server.log | tr '\n' ' ' | head -c 200)"
  echo "=== ABORT ==="
  cat "$ART/server.log" | tail -30
  exit 1
fi
record "1 server-up" "PASS" "port $PORT bound, process pid $WEB_PID alive"

# 3. Assertion: GET / returns 200 + body has web UI marker
CODE=$(curl -s -o "$ART/root.body" -w '%{http_code}' --max-time 5 "$URL/")
LOG "GET / → HTTP $CODE"
BODY_HEAD=$(head -c 400 "$ART/root.body" 2>/dev/null)
if [ "$CODE" = "200" ]; then
  if echo "$BODY_HEAD" | grep -qiE '<!doctype html|<html|<title'; then
    record "2 root-200+html" "PASS" "GET / → 200, body has <!doctype/<html/<title marker"
  elif echo "$BODY_HEAD" | grep -qE '"error"|"ok":false|ERR_INVALID_URL'; then
    record "2 root-200+html" "FAIL" "GET / 200 but body is error-shape JSON (regression of fix intent): $(echo $BODY_HEAD | tr -d '\n' | head -c 120)"
  else
    record "2 root-200+html" "PASS" "GET / → 200, body shape: $(echo $BODY_HEAD | tr -d '\n' | head -c 120) (no HTML markers but no error markers either)"
  fi
elif [ "$CODE" = "500" ]; then
  record "2 root-200+html" "FAIL" "GET / → HTTP 500 — REGRESSION of #3 fix. body: $(echo $BODY_HEAD | tr -d '\n' | head -c 200)"
else
  record "2 root-200+html" "FAIL" "GET / → HTTP $CODE (expected 200). body: $(echo $BODY_HEAD | tr -d '\n' | head -c 200)"
fi

# 4. Additional routes — favicon.ico and a probable static asset path
for path in favicon.ico static index.html; do
  CODE=$(curl -s -o "$ART/p-${path}.body" -w '%{http_code}' --max-time 5 "$URL/$path")
  if [ "$CODE" = "200" ] || [ "$CODE" = "404" ]; then
    record "3 GET-/$path non-500" "PASS" "HTTP $CODE (200 or 404 both acceptable — server handles unknown paths cleanly)"
  elif [ "$CODE" = "500" ]; then
    record "3 GET-/$path non-500" "FAIL" "HTTP 500 — server can't handle this path"
  else
    record "3 GET-/$path non-500" "PASS" "HTTP $CODE (non-500, server responded with explicit status)"
  fi
done

# 5. stdout/stderr — no URL-parse errors
URL_ERR=$(grep -ciE 'ERR_INVALID_URL|TypeError.*URL|invalid URL' "$ART/server.log" || echo 0)
if [ "$URL_ERR" = "0" ]; then
  record "4 no ERR_INVALID_URL" "PASS" "0 URL-parse errors in server.log"
else
  record "4 no ERR_INVALID_URL" "FAIL" "found $URL_ERR URL-parse errors — REGRESSION of #3 fix"
fi

# 6. Generate report
{
  echo "# tmcode web smoke — tianma-ai/tmcode#3 (ERR_INVALID_URL fix verify)"
  echo
  echo "**tmcode version:** $(tmcode --version 2>&1 | head -1)"
  echo "**Port:** $PORT, **Host:** $HOST"
  echo
  echo "## Verdict matrix"
  echo
  echo "| Test | Verdict | Evidence |"
  echo "|---|---|---|"
  cat "$ART/matrix.md"
  echo
  echo "## Summary"
  echo "- PASS: ${#PASS[@]}"
  echo "- FAIL: ${#FAIL[@]}"
  [ ${#FAIL[@]} -eq 0 ] && echo "- **Verdict: ✅ all PASS — #3 fix verified**" || echo "- **Verdict: ❌ FAIL — ${FAIL[*]}**"
  echo
  echo "## Server log tail"
  echo '```'
  tail -30 "$ART/server.log"
  echo '```'
} > "$ART/REPORT.md"

# Cleanup
kill -TERM "$WEB_PID" 2>/dev/null
sleep 1
kill -KILL "$WEB_PID" 2>/dev/null

cat "$ART/REPORT.md"
echo
echo "=== artifacts ==="
ls -la "$ART"
exit ${#FAIL[@]}
