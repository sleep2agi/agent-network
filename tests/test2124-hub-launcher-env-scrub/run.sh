#!/bin/bash
# test2124: 生产 hub 启动器必须清掉继承来的「节点身份」环境变量。
#
# 2026-10-05 实测：生产 hub 进程环境里带着某个 grok 节点的 COMMHUB_TOKEN /
# ANET_NODE_MARKER / CLAUDE_CODE_* / CODEX_* / GROK_* / TMUX…，来自执行那次重启的
# 节点会话。本套件用桩 bun 把 exec 时的环境落盘，断言：
#   ① 身份变量全部消失（精确名 + 前缀 CLAUDE_CODE_*/CODEX_*/GROK_*）
#   ② hub 真正读的配置变量（COMMHUB_DB/COMMHUB_AUTH_TOKEN/COMMHUB_SESSION_IDLE_DAYS…）原样保留
#   ③ hub.env 仍然说了算：它设的值盖过继承值，连名单里的名字也能由 hub.env 显式设回
#   ④ 日志只列名字，不出现任何值
# 自带见证红：把清理调用从脚本里删掉，同一组断言必须变红。
set -euo pipefail

source /lib/safe-rm.sh

SCRIPT=/app/deploy/hub/hub-daemon.sh
RUNTIME_BASENAME=$(sed -n 's|^RUNTIME_DIR="\$HOME/\.commhub/\([^"]*\)"|\1|p' "$SCRIPT")
RUNTIME_BASENAME=${RUNTIME_BASENAME%%$'\n'*}
if [ -z "$RUNTIME_BASENAME" ]; then
  echo "FAIL: 从 $SCRIPT 里取不到 RUNTIME_DIR 的目录名" >&2
  exit 1
fi
ROOT="/tmp/test2124-$$"
trap 'safe_rm_rf "$ROOT"' EXIT

# 被清理的身份名（精确名 + 前缀各至少一个样本）
IDENTITY_VARS=(
  COMMHUB_ALIAS COMMHUB_TOKEN COMMHUB_NODE_ID COMMHUB_RESUME_ID COMMHUB_URL
  ANET_NODE_MARKER ANET_CODEX_COMMHUB_TOKEN ANET_INTERNAL_GROK_COPRESENCE_PROFILE
  ANET_CONFIG_UPDATE_CAPABLE
  CLAUDECODE CLAUDE_PID CLAUDE_EFFORT CLAUDE_PLUGIN_DATA
  CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT
  CODEX_HOME CODEX_SANDBOX
  GROK_BINARY GROK_SESSION
  TMUX TMUX_PANE
)
# hub 真读的配置 → 必须保留（继承值）
KEEP_VARS=(
  COMMHUB_AUTH_TOKEN COMMHUB_SESSION_IDLE_DAYS COMMHUB_STALE_OPEN_TASK_HOURS
  COMMHUB_NODE_PERMISSIONS COMMHUB_ENABLE_SIDE_THREADS COMMHUB_UPLOADS_DIR
  ANET_SSE_KEEPALIVE_MS
)

new_fixture() {
  local dir="$ROOT/$1"
  safe_rm_rf "$dir"
  mkdir -p \
    "$dir/home/.commhub/$RUNTIME_BASENAME/node_modules/@sleep2agi/commhub-server/bin" \
    "$dir/fake-bin"
  : > "$dir/home/.commhub/$RUNTIME_BASENAME/node_modules/@sleep2agi/commhub-server/bin/commhub.ts"
  cat > "$dir/hub.env" <<'ENVEOF'
ANET_HUB_SECRET_VAULT_KEY=test-fixture-only
COMMHUB_DUE_REMINDERS=from-hub-env
GROK_FROM_HUB_ENV=explicit-config-wins
ENVEOF
  cat > "$dir/fake-bin/bun" <<'BUNEOF'
#!/bin/bash
env > "$FAKE_BUN_ENV_DUMP"
BUNEOF
  printf '#!/bin/bash\nexit 0\n' > "$dir/fake-bin/ss"
  printf '#!/bin/bash\nexit 0\n' > "$dir/fake-bin/sleep"
  chmod 0755 "$dir/fake-bin/bun" "$dir/fake-bin/ss" "$dir/fake-bin/sleep"
  printf '%s\n' "$dir"
}

invoke() {
  local script="$1" dir="$2"
  local -a polluted=()
  local n
  for n in "${IDENTITY_VARS[@]}"; do polluted+=("$n=SECRETVAL-$n"); done
  for n in "${KEEP_VARS[@]}"; do polluted+=("$n=keep-$n"); done
  env -i \
    HOME="$dir/home" \
    PATH="$dir/fake-bin:/usr/bin:/bin" \
    BUN_BIN="$dir/fake-bin/bun" \
    SS_BIN="$dir/fake-bin/ss" \
    HUB_ENV_FILE="$dir/hub.env" \
    FAKE_BUN_ENV_DUMP="$dir/env.dump" \
    HOST=127.0.0.1 PORT=19298 \
    COMMHUB_DB="$dir/verify.db" \
    COMMHUB_DUE_REMINDERS=inherited \
    "${polluted[@]}" \
    bash "$script" > "$dir/output.log" 2>&1
}

# check <script> <label>  → 返回 0 = 全部断言通过；失败的断言逐条打印
check() {
  local script="$1" label="$2" dir fails=0 n
  dir="$(new_fixture "$label")"
  invoke "$script" "$dir" || { echo "  [$label] launcher exited non-zero"; fails=$((fails+1)); }
  if [ ! -s "$dir/env.dump" ]; then
    echo "  [$label] stub bun never ran"; sed 's/^/    | /' "$dir/output.log"; return 1
  fi
  for n in "${IDENTITY_VARS[@]}"; do
    if grep -q "^$n=" "$dir/env.dump"; then echo "  [$label] identity var leaked: $n"; fails=$((fails+1)); fi
  done
  for n in "${KEEP_VARS[@]}"; do
    if ! grep -qx "$n=keep-$n" "$dir/env.dump"; then echo "  [$label] config var lost: $n"; fails=$((fails+1)); fi
  done
  grep -qx "COMMHUB_DB=$dir/verify.db" "$dir/env.dump" || { echo "  [$label] COMMHUB_DB lost"; fails=$((fails+1)); }
  grep -qx "ANET_HUB_SECRET_VAULT_KEY=test-fixture-only" "$dir/env.dump" || { echo "  [$label] vault key from hub.env missing"; fails=$((fails+1)); }
  grep -qx "COMMHUB_DUE_REMINDERS=from-hub-env" "$dir/env.dump" || { echo "  [$label] hub.env did not win over inherited value"; fails=$((fails+1)); }
  grep -qx "GROK_FROM_HUB_ENV=explicit-config-wins" "$dir/env.dump" || { echo "  [$label] hub.env-set denylisted-prefix var was scrubbed (scrub ran after source)"; fails=$((fails+1)); }
  if grep -q 'SECRETVAL-' "$dir/output.log"; then echo "  [$label] launcher log printed a value"; fails=$((fails+1)); fi
  for n in COMMHUB_TOKEN ANET_NODE_MARKER CLAUDE_CODE_ENTRYPOINT CODEX_HOME GROK_BINARY TMUX_PANE; do
    if ! grep -qw "$n" "$dir/output.log"; then echo "  [$label] scrub log line does not name $n"; fails=$((fails+1)); fi
  done
  [ "$fails" -eq 0 ]
}

FAIL=0
if check "$SCRIPT" real; then
  echo "L1 HUB_LAUNCHER_ENV_SCRUB_PASS"
else
  echo "FAIL: real launcher"; FAIL=1
fi

# 见证红：删掉清理调用，同一组断言必须红
MUT="$ROOT/mutated-hub-daemon.sh"
mkdir -p "$ROOT"
sed '/^_scrub_node_identity_env$/d' "$SCRIPT" > "$MUT"
if cmp -s "$SCRIPT" "$MUT"; then
  echo "FAIL: MUTATION_NOOP — 脚本里找不到独占一行的 _scrub_node_identity_env 调用"; FAIL=1
else
  mut_out=$(check "$MUT" mutated 2>&1 || echo "__RED__")
  if printf '%s' "$mut_out" | grep -q '__RED__'; then
    echo "MUTATION_RED scrub-call-removed"
  else
    echo "FAIL: mutation stayed green — the assertions do not detect a missing scrub"; FAIL=1
  fi
fi

mkdir -p "${ARTIFACT_DIR:-/tmp/art}"
if [ "$FAIL" -eq 0 ]; then
  echo "RESULT: PASS" | tee "${ARTIFACT_DIR:-/tmp/art}/report.txt"
else
  echo "RESULT: FAIL" | tee "${ARTIFACT_DIR:-/tmp/art}/report.txt"
  exit 1
fi
