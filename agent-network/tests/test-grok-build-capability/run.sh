#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR="${ARTIFACT_DIR:-/artifacts}"
REPORT="${REPORT:-/artifacts/report-grok-build-capability.txt}"
GROK_VERSION_EXPECTED="${GROK_VERSION_EXPECTED:-}"
mkdir -p "$ARTIFACT_DIR" "$HOME/.grok"

mask() {
  sed -E \
    -e 's/(xai-|sk-|gsk-|ghp_|github_pat_)[A-Za-z0-9._-]+/\\1•••MASKED•••/g' \
    -e 's/("refresh_token"[[:space:]]*:[[:space:]]*")[^"]+(")/\\1•••MASKED•••\\2/g' \
    -e 's/("access_token"[[:space:]]*:[[:space:]]*")[^"]+(")/\\1•••MASKED•••\\2/g'
}

log() {
  printf '%s\n' "$*" | tee -a "$REPORT"
}

run_capture() {
  local name="$1"
  shift
  set +e
  "$@" >"$ARTIFACT_DIR/$name.stdout" 2>"$ARTIFACT_DIR/$name.stderr"
  local code=$?
  set -e
  cat "$ARTIFACT_DIR/$name.stdout" "$ARTIFACT_DIR/$name.stderr" | mask >"$ARTIFACT_DIR/$name.log"
  rm -f "$ARTIFACT_DIR/$name.stdout" "$ARTIFACT_DIR/$name.stderr"
  echo "$code" >"$ARTIFACT_DIR/$name.exit"
  return "$code"
}

install_grok() {
  if command -v grok >/dev/null 2>&1; then
    return 0
  fi

  log "T0 install: grok missing, installing via xAI install script"
  curl -fsSL https://x.ai/cli/install.sh | bash

  export PATH="$HOME/.local/bin:$HOME/.grok/bin:$PATH"
  if ! command -v grok >/dev/null 2>&1; then
    log "FAIL: grok install completed but grok is not on PATH"
    return 1
  fi
}

setup_auth() {
  if [ -n "${GROK_CODE_XAI_API_KEY:-}" ]; then
    echo "env" >"$ARTIFACT_DIR/auth-mode.txt"
    log "T1 auth: env mode (GROK_CODE_XAI_API_KEY present; value redacted)"
    return 0
  fi

  if [ -f /host-grok/auth.json ]; then
    ln -sf /host-grok/auth.json "$HOME/.grok/auth.json"
    [ -f /host-grok/agent_id ] && ln -sf /host-grok/agent_id "$HOME/.grok/agent_id"
    [ -f /host-grok/config.toml ] && ln -sf /host-grok/config.toml "$HOME/.grok/config.toml"
    echo "host-mount" >"$ARTIFACT_DIR/auth-mode.txt"
    log "T1 auth: host-mount mode (read-only auth files mounted; contents redacted)"
    return 0
  fi

  echo "skip" >"$ARTIFACT_DIR/auth-mode.txt"
  log "SKIP: no GROK_CODE_XAI_API_KEY and no /host-grok/auth.json"
  exit 0
}

: >"$REPORT"
log "# Grok Build Capability Probe"
log ""
log "- date: $(date -Is)"
log "- cwd: $(pwd)"

export PATH="$HOME/.local/bin:$HOME/.grok/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

setup_auth
install_grok

grok --version | tee "$ARTIFACT_DIR/version.txt" | tee -a "$REPORT"
if [ -n "$GROK_VERSION_EXPECTED" ] && ! grep -q "$GROK_VERSION_EXPECTED" "$ARTIFACT_DIR/version.txt"; then
  log "WARN: expected Grok version $GROK_VERSION_EXPECTED, got $(cat "$ARTIFACT_DIR/version.txt")"
fi

log ""
log "## T1 auth command probe"
if grok auth --help >"$ARTIFACT_DIR/auth-help.txt" 2>&1; then
  if grok auth status >"$ARTIFACT_DIR/auth-status.raw" 2>&1; then
    mask <"$ARTIFACT_DIR/auth-status.raw" >"$ARTIFACT_DIR/auth-status.txt"
    log "PASS: grok auth status succeeded"
  else
    mask <"$ARTIFACT_DIR/auth-status.raw" >"$ARTIFACT_DIR/auth-status.txt"
    log "WARN: grok auth status unavailable/failed; using headless smoke as auth proof"
  fi
else
  log "WARN: grok auth command unavailable; using headless smoke as auth proof"
fi

mkdir -p /tmp/grok-probe
printf 'hello-from-probe\n' >/tmp/grok-probe/fixture.txt

log ""
log "## T2 headless json smoke"
if run_capture t2-json timeout 90s grok -p "Reply with exactly OK." --output-format json --max-turns 32 --cwd /tmp/grok-probe; then
  jq . "$ARTIFACT_DIR/t2-json.log" >"$ARTIFACT_DIR/t2-json.json" 2>/dev/null || cp "$ARTIFACT_DIR/t2-json.log" "$ARTIFACT_DIR/t2-json.json"
  log "PASS: headless json completed"
else
  log "FAIL: headless json failed"
fi

log ""
log "## T3 streaming-json smoke"
if run_capture t3-streaming timeout 90s grok -p "List the files in the current directory." --output-format streaming-json --max-turns 32 --cwd /tmp/grok-probe; then
  cp "$ARTIFACT_DIR/t3-streaming.log" "$ARTIFACT_DIR/t3-streaming.jsonl"
  log "PASS: streaming-json completed"
else
  log "FAIL: streaming-json failed"
fi

log ""
log "## T4 session continue smoke"
SESSION_ID="anet-grok-probe-$(date +%s)"
if run_capture t4-session-a timeout 180s grok -p "Remember the marker ANET_GROK_MARKER." --session-id "$SESSION_ID" --output-format json --max-turns 32 --cwd /tmp/grok-probe; then
  ACTUAL_SESSION_ID="$(jq -r '.sessionId // empty' "$ARTIFACT_DIR/t4-session-a.log" 2>/dev/null || true)"
  if [ -z "$ACTUAL_SESSION_ID" ]; then
    ACTUAL_SESSION_ID="$SESSION_ID"
  fi
else
  ACTUAL_SESSION_ID="$SESSION_ID"
fi
if [ -s "$ARTIFACT_DIR/t4-session-a.exit" ] && [ "$(cat "$ARTIFACT_DIR/t4-session-a.exit")" = "0" ] \
  && run_capture t4-session-b timeout 180s grok -p "What marker did I ask you to remember? Reply with only the marker." --resume "$ACTUAL_SESSION_ID" --output-format json --max-turns 32 --cwd /tmp/grok-probe; then
  jq -n \
    --arg requested_session_id "$SESSION_ID" \
    --arg actual_session_id "$ACTUAL_SESSION_ID" \
    --rawfile first "$ARTIFACT_DIR/t4-session-a.log" \
    --rawfile second "$ARTIFACT_DIR/t4-session-b.log" \
    '{requested_session_id:$requested_session_id, actual_session_id:$actual_session_id, first:$first, second:$second}' >"$ARTIFACT_DIR/t4-session.json"
  log "PASS: session resume completed"
else
  log "FAIL: session resume failed"
fi

log ""
log "## T5 cwd isolation"
if run_capture t5-cwd timeout 90s grok -p "Read fixture.txt and reply with its exact contents." --output-format json --max-turns 32 --cwd /tmp/grok-probe; then
  cp "$ARTIFACT_DIR/t5-cwd.log" "$ARTIFACT_DIR/t5-cwd.json"
  log "PASS: cwd smoke completed"
else
  log "FAIL: cwd smoke failed"
fi

log ""
log "## T6 ACP stdio fixture"
mkdir -p "$ARTIFACT_DIR/t6-acp"
if ARTIFACT_DIR="$ARTIFACT_DIR/t6-acp" PROBE_CWD=/tmp/grok-probe timeout 120s node /probe/acp-probe.mjs; then
  log "PASS: ACP stdio probe completed"
else
  log "FAIL: ACP stdio probe failed"
fi

log ""
log "## T7 approval behavior"
if run_capture t7-approval timeout 90s grok -p "Create a file named approval-probe.txt containing OK in the current directory." --output-format streaming-json --max-turns 32 --cwd /tmp/grok-probe; then
  cp "$ARTIFACT_DIR/t7-approval.log" "$ARTIFACT_DIR/t7-approval-behavior.txt"
  log "PASS: approval behavior captured"
else
  cp "$ARTIFACT_DIR/t7-approval.log" "$ARTIFACT_DIR/t7-approval-behavior.txt" 2>/dev/null || true
  log "WARN: approval behavior command failed; captured stderr/stdout if any"
fi

log ""
log "## T8 ACP session/load after completed prompt"
mkdir -p "$ARTIFACT_DIR/t8-resume-after-done"
if ARTIFACT_DIR="$ARTIFACT_DIR/t8-resume-after-done" PROBE_MODE=resume-after-done PROBE_CWD=/tmp/grok-probe timeout 180s node /probe/acp-resume-probe.mjs; then
  log "PASS: ACP session/load after completed prompt works"
else
  log "FAIL: ACP session/load after completed prompt failed"
fi

log ""
log "## T9 ACP process abort then session/load"
mkdir -p "$ARTIFACT_DIR/t9-abort-resume"
if ARTIFACT_DIR="$ARTIFACT_DIR/t9-abort-resume" PROBE_MODE=abort-resume PROBE_CWD=/tmp/grok-probe timeout 180s node /probe/acp-resume-probe.mjs; then
  log "PASS: ACP process abort then session/load works"
else
  log "FAIL: ACP process abort then session/load failed"
fi

log ""
log "## Artifact index"
find "$ARTIFACT_DIR" -maxdepth 3 -type f | sort | sed "s#^$ARTIFACT_DIR#- artifacts#" | tee -a "$REPORT"
