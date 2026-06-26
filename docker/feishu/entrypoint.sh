#!/usr/bin/env bash
# Feishu agent container entrypoint — fully non-interactive bring-up.
#
# Flow (each step idempotent so container restart is safe):
#   1. fail-fast env validation
#   2. `anet init --hub $HUB_URL` (writes ~/.anet/config.json hub URL)
#   3. `anet login --username $HUB_USER --password $HUB_PASSWORD`
#      (POSTs /api/auth/login, stores utok_)
#   4. `anet node create $NODE_ALIAS --runtime claude-agent-sdk --model $ANET_MODEL`
#      (only if node not already created — checks .anet/nodes/<alias>/config.json)
#   5. `anet channel add feishu $NODE_ALIAS --app-id ... --app-secret ... [--allow ...]`
#      (idempotent — already-added is downgraded to a log line, not a hard
#      fail)
#   6. `exec agent-node ...` so the agent runs as PID 1 (under tini) —
#      SIGTERM from `docker stop` reaches the agent cleanly.
#
# Non-interactivity verified at source level (agent-network/bin/cli.ts:
# loginCommand reads opts.username / opts.password and skips ask() when
# both provided; node create skips the vendor wizard when ANTHROPIC_AUTH_TOKEN
# is in env — we export it from .env, so the create runs scripted).

set -e
# `pipefail` is critical: every command below pipes its stdout through
# `sed` to prefix log lines. Without pipefail the pipe's exit status
# is sed's (always 0), so a failed `anet login` would silently pass
# and we'd boot a broken agent.
set -o pipefail

# ── fail-fast env checks ──────────────────────────────────────────────────
# `${VAR:?msg}` aborts with the message when VAR is unset/empty — gives the
# user a precise "missing FOO" line instead of a downstream cryptic failure.
: "${HUB_URL:?missing — set HUB_URL=https://your-hub in .env}"
: "${HUB_USER:?missing — set HUB_USER=<your-username> in .env}"
: "${HUB_PASSWORD:?missing — set HUB_PASSWORD=<your-password> in .env}"
: "${FEISHU_APP_ID:?missing — set FEISHU_APP_ID=cli_xxx in .env}"
: "${FEISHU_APP_SECRET:?missing — set FEISHU_APP_SECRET=xxx in .env}"
: "${ANET_MODEL:?missing — set ANET_MODEL=deepseek-v4-pro (or MiniMax-M3 etc) in .env}"
: "${ANTHROPIC_BASE_URL:?missing — set ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic in .env}"
: "${ANTHROPIC_AUTH_TOKEN:?missing — set ANTHROPIC_AUTH_TOKEN=sk-... in .env}"

NODE_ALIAS="${NODE_ALIAS:-feishu-agent}"

cd /work

echo "[feishu-entrypoint] starting bring-up for node '${NODE_ALIAS}' against hub ${HUB_URL}"

# ── 1) hub URL into ~/.anet/config.json ──────────────────────────────────
# `anet init` writes the hub URL into the global config. Idempotent: a
# second invocation just overwrites with the same value. We do NOT pass a
# token here — login below issues the user-token.
#
# `</dev/null` is required: `anet init` prompts for an optional "legacy
# auth token" even when --hub is given (asks the operator to press
# Enter to skip). In a non-TTY container that hangs forever. Piping in
# empty stdin makes the prompt return the default (skip).
anet init --hub "$HUB_URL" </dev/null 2>&1 | sed 's/^/[init] /' || true

# ── 2) login (non-interactive) ───────────────────────────────────────────
# loginCommand at agent-network/bin/cli.ts:5494 reads `--username` and
# `--password` flags before falling back to ask() — providing both skips
# the interactive prompt entirely.
#
# Auth-failure detection is explicit: `anet login` currently exits 0
# even when /api/auth/login rejects credentials (it just prints
# `❌ Login failed`). pipefail / set -e can't catch that, so we capture
# output, prefix-log it, and grep for the marker. Reachability errors
# ("Cannot reach hub") and auth errors both contain `❌`.
echo "[login] POST ${HUB_URL}/api/auth/login as ${HUB_USER}"
LOGIN_LOG="$(mktemp)"
anet login --hub "$HUB_URL" --username "$HUB_USER" --password "$HUB_PASSWORD" </dev/null > "$LOGIN_LOG" 2>&1 || true
sed 's/^/[login] /' "$LOGIN_LOG"
if ! grep -q "✅ Logged in" "$LOGIN_LOG"; then
  echo "[login] ❌ FATAL — login did not succeed. See log above. Check HUB_URL / HUB_USER / HUB_PASSWORD in .env."
  rm -f "$LOGIN_LOG"
  exit 1
fi
rm -f "$LOGIN_LOG"

# ── 3) node create (idempotent — skip when node config already exists) ──
NODE_CONFIG=".anet/nodes/${NODE_ALIAS}/config.json"
if [ -f "$NODE_CONFIG" ]; then
  echo "[node] '${NODE_ALIAS}' already exists at ${NODE_CONFIG} — skip create"
else
  echo "[node] creating '${NODE_ALIAS}' runtime=claude-agent-sdk model=${ANET_MODEL}"
  # ANTHROPIC_AUTH_TOKEN already in env (from .env) — agent-network sees
  # credAlreadyProvided=true and skips the vendor picker (cli.ts:1997).
  anet node create "$NODE_ALIAS" \
      --runtime claude-agent-sdk \
      --model "$ANET_MODEL" \
    2>&1 | sed 's/^/[node] /'
fi

# ── 4) channel add feishu (idempotent — already-added → log + continue) ──
ALLOW_FLAGS=()
if [ -n "${FEISHU_ALLOW_FROM:-}" ]; then
  ALLOW_FLAGS+=(--allow "$FEISHU_ALLOW_FROM")
fi
if [ -n "${FEISHU_ALLOW_CHATS:-}" ]; then
  ALLOW_FLAGS+=(--allow-chat "$FEISHU_ALLOW_CHATS")
fi
echo "[channel] adding feishu to '${NODE_ALIAS}'${ALLOW_FLAGS:+ (with ${#ALLOW_FLAGS[@]}/2 allow flags)}"
anet channel add feishu "$NODE_ALIAS" \
    --app-id "$FEISHU_APP_ID" \
    --app-secret "$FEISHU_APP_SECRET" \
    "${ALLOW_FLAGS[@]}" \
  2>&1 | sed 's/^/[channel] /' || {
    # Tolerate "already added" — first-run vs restart-run distinction
    # is in the exit code; for now we always continue and let the agent
    # decide whether the channel is healthy.
    echo "[channel] add returned non-zero (likely already-added on restart) — continuing"
  }

# ── 5) start agent-node — PID 1 under tini ──────────────────────────────
echo "[start] exec agent-node alias=${NODE_ALIAS} config=${NODE_CONFIG}"
exec agent-node --config "$NODE_CONFIG" --alias "$NODE_ALIAS"
