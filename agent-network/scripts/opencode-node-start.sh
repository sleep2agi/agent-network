#!/usr/bin/env bash
# agent-network/scripts/opencode-node-start.sh — #521 + #523
#
# The opencode agent-node start recipe, made script-shaped so it can be
# submitted to pm2 (foreground process) instead of living in an ad-hoc
# nohup command that only exists in someone's shell history.
#
# Design notes:
#   - This script is FOREGROUND-blocking on purpose: pm2 needs to
#     watch the child, so we `exec` into agent-node at the end without
#     backgrounding.
#   - The prerequisites of the opencode runtime (per #521) are each
#     asserted independently with fail-closed semantics; a red
#     preflight names the specific missing prerequisite instead of
#     dying with a downstream ambiguous error 30s later.
#   - We deliberately do NOT `set -e` — `set -uo pipefail` is enough
#     to fail-closed on any real error while letting us decide when
#     to accumulate and report vs bail. Same convention as tests/qa-*
#     runners in the repo.
#
# Usage:
#   opencode-node-start.sh --alias <alias>
#     [--node-home /home/vansin/opencode-node]
#     [--support /home/vansin/opencode-support]
#     [--debug]                # opt-in — see note below
#
# Log level: default is agent-node's normal level. `--debug` is
# opt-in for troubleshooting. Debug is intentionally NOT the default
# because (a) it pumps volume on a long-running node — magnetic on
# a 95%-full disk — and (b) it can print token prefixes / message
# bodies to the log. The one operational reason debug was previously
# hardcoded (self-skip diagnosis, #522) is being fixed at the source
# in #522, after which the diagnostic line survives at normal level.
# The two issues are a set: #522 lets default-level be sufficient;
# #521 (this script) shifts the default down.
#
# Meant to be launched via
#   pm2 start agent-network/scripts/pm2-opencode.config.js
# (see the ecosystem file next to this one). Running by hand is fine
# for a smoke test, but production wants it under pm2 so a crash gets
# an automatic restart (#523).

set -uo pipefail

# ── Defaults matching the observed 2026-07-30 recipe ─────────────
ALIAS=""
NODE_HOME="/home/vansin/opencode-node"
SUPPORT_HOME="/home/vansin/opencode-support"
DEBUG=0
# --preflight-only: run preflight and exit 0 WITHOUT spawning agent-node.
# 🔴 Motivation: attempting to sed the exec line out at runtime for a
# "dry check" is fragile — the script has two exec branches (--debug
# on/off), and a sed that only patched the first branch let the second
# branch spawn a rogue duplicate opencode-测试1号 in a live prod hub
# (2026-07-30 near-miss; contained by precise-pid kill). Use this flag
# for any verification that shouldn't actually launch a node.
PREFLIGHT_ONLY=0

# ── Argv parse ───────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --alias)          ALIAS="$2"; shift 2 ;;
    --node-home)      NODE_HOME="$2"; shift 2 ;;
    --support)        SUPPORT_HOME="$2"; shift 2 ;;
    --debug)          DEBUG=1; shift 1 ;;
    --preflight-only) PREFLIGHT_ONLY=1; shift 1 ;;
    -h|--help)
      grep '^# ' "$0" | sed 's/^# //'
      exit 0
      ;;
    *)
      echo "::error::unknown argument: $1"
      exit 2
      ;;
  esac
done

if [ -z "$ALIAS" ]; then
  echo "::error::--alias is required (e.g. --alias opencode测试1号)"
  exit 2
fi

# ── Derived paths ────────────────────────────────────────────────
SUPPORT_MODULES="$SUPPORT_HOME/node_modules"
CONFIG_PATH="$NODE_HOME/.anet/nodes/$ALIAS/config.json"
AGENT_NODE_BIN="$NODE_HOME/node_modules/.bin/agent-node"

# ── Preflight — each check on its own ✗ line (#526 pattern) ─────
missing=0
say_ok() { echo "  ✓ preflight: $*"; }
say_bad() { echo "  ✗ preflight: $*"; missing=$((missing+1)); }

echo "── preflight: opencode-node-start (alias=$ALIAS) ──"

# 1. cwd — must be an opencode-node install with its own node_modules.
if [ ! -d "$NODE_HOME" ]; then
  say_bad "NODE_HOME does not exist: $NODE_HOME"
elif [ ! -d "$NODE_HOME/node_modules" ]; then
  say_bad "NODE_HOME has no node_modules — did you 'npm install' in $NODE_HOME?"
else
  say_ok "NODE_HOME present with node_modules ($NODE_HOME)"
fi

# 2. SUPPORT — must contain opencode-ai (provides opencode.exe on PATH).
if [ ! -d "$SUPPORT_MODULES" ]; then
  say_bad "SUPPORT node_modules missing: $SUPPORT_MODULES"
elif [ ! -x "$SUPPORT_MODULES/.bin/opencode" ] && [ ! -x "$SUPPORT_MODULES/opencode-ai/bin/opencode.exe" ]; then
  say_bad "opencode binary not found in $SUPPORT_MODULES (need opencode-ai)"
else
  # Report whichever we found so the log makes clear which path the
  # runtime will actually use.
  found=""
  [ -x "$SUPPORT_MODULES/.bin/opencode" ] && found="$SUPPORT_MODULES/.bin/opencode"
  [ -z "$found" ] && found="$SUPPORT_MODULES/opencode-ai/bin/opencode.exe"
  say_ok "opencode binary present ($found)"
fi

# 2b. 🔴 NEGATIVE assertion — opencode-ai MUST NOT be installed INSIDE
# NODE_HOME. agent-node has a supply-chain guard that refuses to
# start when opencode-ai resolves inside the node's workDir
# ("resolved opencode-ai package overlaps forbidden root"). The
# recipe requires opencode-ai to live in SUPPORT_HOME (external),
# not inside NODE_HOME/node_modules. This is counter-intuitive —
# a well-meaning `npm i opencode-ai` inside the project would
# break the node with an opaque runtime error. Fail-closed here
# with a preflight message that tells the reader exactly what to
# do about it. — 通信龙 empirical, 2026-07-30 middag lunch case.
if [ -e "$NODE_HOME/node_modules/opencode-ai" ]; then
  say_bad "opencode-ai is installed INSIDE the node workDir ($NODE_HOME/node_modules/opencode-ai) — agent-node's supply-chain guard will refuse to start with 'overlaps forbidden root'. Move it to \$SUPPORT_HOME/node_modules and set NODE_PATH to point there (this script does that automatically once opencode-ai is in the right place)."
else
  say_ok "no opencode-ai leak in workDir (workDir supply-chain guard ok)"
fi

# 3. Node config file must exist and be valid JSON with matching alias.
if [ ! -f "$CONFIG_PATH" ]; then
  say_bad "node config missing: $CONFIG_PATH — did you 'anet node create $ALIAS'?"
else
  cfg_alias=$(python3 -c "import json,sys;print(json.load(open('$CONFIG_PATH')).get('alias',''))" 2>/dev/null || echo "")
  if [ "$cfg_alias" != "$ALIAS" ]; then
    say_bad "node config alias mismatch: file says '$cfg_alias', argv says '$ALIAS'"
  else
    say_ok "node config present + alias matches ($CONFIG_PATH)"
  fi
fi

# 3b. 🔴 NODE workDir + config.json owner+mode gates.
#
# agent-node's OpenCode state module has TWO paired supply-chain
# guards. Both refuse to bind unless owner=current-uid AND the
# specified mode. Silent restart-loop otherwise (empirically it
# looks like the agent starts and pm2 immediately restarts, over
# and over — the stderr reveals the real cause):
#
#   ERR 1: [agent-node] Refusing unsafe OpenCode config: OpenCode
#          state refuses node workDir at <dir>: owner/mode must be
#          current uid/0700
#   ERR 2: [agent-node] Refusing unsafe OpenCode config: OpenCode
#          state refuses config.json at <file>: owner/mode must be
#          current uid/0600
#
# Discovered 2026-07-30 empirically — cat/mkdir with default umask
# (usually 022→755/644 or 002→775/664) both flunk the guards.
# `anet node create` gets this right; hand-creating a node misses.
# Fail-closed here with explicit remediation. Both guards.
NODE_DIR="$NODE_HOME/.anet/nodes/$ALIAS"
self_uid=$(id -u)
if [ -d "$NODE_DIR" ]; then
  dir_owner=$(stat -c '%u' "$NODE_DIR" 2>/dev/null || echo "?")
  dir_mode=$(stat -c '%a' "$NODE_DIR" 2>/dev/null || echo "?")
  if [ "$dir_owner" != "$self_uid" ]; then
    say_bad "node workDir owner mismatch: uid=$dir_owner, expected uid=$self_uid — run 'chown $self_uid $NODE_DIR'"
  elif [ "$dir_mode" != "700" ]; then
    say_bad "node workDir mode is $dir_mode, expected 0700 — run 'chmod 0700 $NODE_DIR' (agent-node OpenCode guard rejects otherwise)"
  else
    say_ok "node workDir owner+mode ok (uid=$self_uid, mode=0700)"
  fi
fi
# 3c. config.json owner+mode gate (paired with 3b).
if [ -f "$CONFIG_PATH" ]; then
  cfg_owner=$(stat -c '%u' "$CONFIG_PATH" 2>/dev/null || echo "?")
  cfg_mode=$(stat -c '%a' "$CONFIG_PATH" 2>/dev/null || echo "?")
  if [ "$cfg_owner" != "$self_uid" ]; then
    say_bad "config.json owner mismatch: uid=$cfg_owner, expected uid=$self_uid — run 'chown $self_uid $CONFIG_PATH'"
  elif [ "$cfg_mode" != "600" ]; then
    say_bad "config.json mode is $cfg_mode, expected 0600 — run 'chmod 0600 $CONFIG_PATH' (agent-node OpenCode guard rejects otherwise)"
  else
    say_ok "config.json owner+mode ok (uid=$self_uid, mode=0600)"
  fi
fi

# 4. agent-node binary — must be executable.
if [ ! -x "$AGENT_NODE_BIN" ]; then
  say_bad "agent-node binary missing/not-executable: $AGENT_NODE_BIN"
else
  say_ok "agent-node binary present ($AGENT_NODE_BIN)"
fi

# 5. Node.js — pm2 fleet runs on nvm node v20; verify a `node` is on
# PATH regardless. The exec at the bottom of this script will use
# whatever `node` resolves to when pm2 calls us, and pm2's own PATH
# is not our concern here.
if ! command -v node >/dev/null 2>&1; then
  say_bad "node not on PATH (pm2's PATH must include a node binary)"
else
  say_ok "node present ($(command -v node), version $(node --version))"
fi

# 6. Env pollution — the recipe explicitly unsets COMMHUB_ALIAS /
# COMMHUB_TOKEN before spawning agent-node so a parent shell's env
# doesn't leak into the child (would cause identity mismatch on the
# hub if the parent had a different node's creds). Verify they're
# either unset or we'll unset them. We do NOT fail on presence —
# unset happens below — but we DO surface it in the log.
if [ -n "${COMMHUB_ALIAS:-}" ] || [ -n "${COMMHUB_TOKEN:-}" ]; then
  say_ok "env pollution present (COMMHUB_ALIAS='${COMMHUB_ALIAS:-}' / COMMHUB_TOKEN=<len ${#COMMHUB_TOKEN}>) — will unset before spawn"
else
  say_ok "env clean (no COMMHUB_ALIAS / COMMHUB_TOKEN in parent env)"
fi

if [ "$missing" -gt 0 ]; then
  echo "::error::preflight failed with $missing missing prerequisite(s) — see ✗ lines above."
  exit 1
fi

# ── --preflight-only: stop here, do NOT spawn agent-node ─────────
if [ "$PREFLIGHT_ONLY" -eq 1 ]; then
  echo "── preflight-only mode: not launching agent-node ──"
  exit 0
fi

# ── Launch agent-node in-place (exec, no background) ─────────────
echo "── preflight ok · launching agent-node (foreground for pm2) ──"
cd "$NODE_HOME" || { echo "::error::chdir to $NODE_HOME failed"; exit 1; }
export NODE_PATH="$SUPPORT_MODULES"
export PATH="$SUPPORT_MODULES/.bin:$NODE_HOME/node_modules/.bin:$PATH"

# 🔴 Clear ALL COMMHUB_* env vars by pattern, not by enumeration.
# Motivation (2026-07-30 opencode #521/#523 near-miss): the previous
# `unset COMMHUB_ALIAS COMMHUB_TOKEN` was enumerated, missed
# COMMHUB_NODE_ID + COMMHUB_RESUME_ID that had polluted the caller's
# shell, and agent-node's cli.ts:600 (`process.env.COMMHUB_NODE_ID
# || fileConfig.node_id`) let the stale env override the node's own
# config. Result: canonical-alias fetch by nodeId hit the offline
# 2号 audit row → alias_identity_mismatch crash-loop.
# Pattern-clear catches every current AND future COMMHUB_* variable.
# Enumeration always misses something eventually.
# — 通信龙 empirical fix, 2026-07-30 late night.
for _oc_env_var in $(env | sed -n 's/^\(COMMHUB_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$_oc_env_var"
done
unset _oc_env_var

# `exec` — this process becomes agent-node. pm2 tracks THIS pid. No
# backgrounding, no nohup, no `&`. If agent-node dies, pm2 sees the
# exit code and applies its restart policy.
if [ "$DEBUG" -eq 1 ]; then
  exec "$AGENT_NODE_BIN" --config "$CONFIG_PATH" --log-level debug
else
  # Default level — see file header re: #522.
  exec "$AGENT_NODE_BIN" --config "$CONFIG_PATH"
fi
