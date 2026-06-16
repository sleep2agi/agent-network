#!/usr/bin/env bash
set -Eeuo pipefail

export HOME=/tmp/anethome
export PATH="/tmp/fake-bin:$PATH"
WORK=/tmp/anet-r13-probe
CLI=/app/agent-network/bin/cli.ts
NODE_DIR="$WORK/.anet/nodes/claude-bot"
CONFIG="$NODE_DIR/config.json"
ARGS_LOG=/tmp/claude-args.log

# P0 guardrail (2026-06-16 incident retro) — destructive rm -rf must NEVER
# touch anything outside /tmp/*. The `export HOME=/tmp/anethome` above is
# the intended sandbox, but if that line is ever removed / accidentally
# unset / overridden by a parent shell, the unguarded rm below would wipe
# the real /home/<user> directory (per the test-new-user-flow.sh incident
# that lost ai-insight / blueleap / paper repos before cloud snapshot
# restore). Refuse to proceed if any rm target is outside /tmp/*.
for _path in "$HOME" "$WORK" /tmp/fake-bin "$ARGS_LOG"; do
  case "$_path" in
    /tmp/*) ;;
    *) echo "[run.sh] REFUSE: refusing to rm -rf '$_path' (outside /tmp/*). HOME=$HOME WORK=$WORK ARGS_LOG=$ARGS_LOG" >&2; exit 99 ;;
  esac
done

rm -rf "$HOME" "$WORK" /tmp/fake-bin "$ARGS_LOG"
mkdir -p "$HOME" "$WORK" /tmp/fake-bin "$NODE_DIR"

cat >/tmp/fake-bin/claude <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  echo "claude 2.1.139"
  exit 0
fi
if [ "${1:-}" = "--help" ]; then
  if [ "${FAKE_CLAUDE_SUPPORTS_SESSION_ID:-1}" = "1" ]; then
    echo "Usage: claude [--session-id <uuid>] [--resume <uuid>]"
  else
    echo "Usage: claude [--resume <uuid>]"
  fi
  exit 0
fi
printf '%s\n' "$*" >> "${ARGS_LOG:-/tmp/claude-args.log}"
exit 0
SH
chmod +x /tmp/fake-bin/claude

write_config() {
  local session_json="$1"
  cat >"$CONFIG" <<JSON
{
  "anet_version": "0.1.0",
  "node_id": "n_test31",
  "node_name": "claude-bot",
  "alias": "claude-bot",
  "runtime": "claude-code-cli",
  "token": "ntok_test31",
  "channels": ["server:commhub"],
  "env": {},
  "flags": {
    "dangerouslySkipPermissions": true,
    "teammateMode": "in-process"
  }$session_json
}
JSON
}

json_session() {
  node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!c.session) process.exit(2); process.stdout.write(c.session)' "$CONFIG"
}

last_args() {
  tail -n 1 "$ARGS_LOG"
}

encoded_cwd() {
  node -e 'process.stdout.write(process.argv[1].replace(/\//g, "-"))' "$WORK"
}

run_start() {
  (cd "$WORK" && ARGS_LOG="$ARGS_LOG" bun "$CLI" node start claude-bot "$@")
}

echo "[L0] old config without session gets session-id on first start"
write_config ""
FAKE_CLAUDE_SUPPORTS_SESSION_ID=1 run_start
SESSION1=$(json_session)
test ${#SESSION1} -ge 32
last_args | grep -q -- "--session-id $SESSION1"
if last_args | grep -q -- "--resume"; then
  echo "unexpected --resume on first start"
  exit 1
fi

echo "[L1] existing Claude jsonl uses --resume"
PROJECT_DIR="$HOME/.claude/projects/$(encoded_cwd)"
mkdir -p "$PROJECT_DIR"
touch "$PROJECT_DIR/$SESSION1.jsonl"
FAKE_CLAUDE_SUPPORTS_SESSION_ID=1 run_start
last_args | grep -q -- "--resume $SESSION1"

echo "[L2] --new-session writes a new UUID and uses --session-id"
FAKE_CLAUDE_SUPPORTS_SESSION_ID=1 run_start --new-session
SESSION2=$(json_session)
test "$SESSION2" != "$SESSION1"
last_args | grep -q -- "--session-id $SESSION2"

echo "[L3] legacy Claude CLI without --session-id falls back to --resume"
write_config ', "session": "legacy-session-uuid"'
FAKE_CLAUDE_SUPPORTS_SESSION_ID=0 run_start 2>/tmp/legacy-warn.log
last_args | grep -q -- "--resume legacy-session-uuid"
grep -q -- "does not advertise --session-id" /tmp/legacy-warn.log

echo "[L4] cwd encoding matches Claude projects path"
test "$(encoded_cwd)" = "-tmp-anet-r13-probe"

echo "PASS test31 claude-code-cli resume"
