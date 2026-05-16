#!/usr/bin/env bash
# Re-vendor codex schema types into src/types/codex/
# Usage: bash scripts/vendor-codex-types.sh
set -euo pipefail
cd "$(dirname "$0")/.."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "[vendor-codex-types] sparse-cloning openai/codex..."
git clone --depth 1 --filter=blob:none --sparse https://github.com/openai/codex.git "$TMP/codex-src" 2>&1 | tail -1
cd "$TMP/codex-src"
git sparse-checkout set codex-rs/app-server-protocol/schema/typescript >/dev/null
cd - >/dev/null

SRC="$TMP/codex-src/codex-rs/app-server-protocol/schema/typescript"
DST="src/types/codex"

rm -rf "$DST/v2" "$DST/serde_json"
mkdir -p "$DST/v2" "$DST/serde_json"

SEEDS=(
  InitializeParams InitializeResponse
  ThreadStartParams ThreadStartResponse ThreadStartedNotification Thread ThreadStatus ThreadActiveFlag
  TurnStartParams TurnStartResponse TurnStartedNotification TurnCompletedNotification
  Turn TurnStatus TurnPlanStep TurnPlanStepStatus UserInput
  ThreadItem ItemStartedNotification ItemCompletedNotification AgentMessageDeltaNotification
  RemoteControlConnectionStatus RemoteControlStatusChangedNotification
  McpServerStartupState McpServerStatusUpdatedNotification
  AbsolutePathBuf
)

for s in "${SEEDS[@]}"; do
  [ -f "$SRC/v2/$s.ts" ] && cp "$SRC/v2/$s.ts" "$DST/v2/$s.ts" || true
  [ -f "$SRC/$s.ts" ] && cp "$SRC/$s.ts" "$DST/$s.ts" || true
done

for iter in 1 2 3 4 5 6 7 8 9 10; do
  imports=$(grep -hE '^import type \{[^}]+\} from' "$DST/v2/"*.ts "$DST/"*.ts 2>/dev/null \
    | sed -E 's|.*from "\.\./([^"/]+)".*|\1|; s|.*from "\.\./serde_json/([^"]+)".*|serde_json/\1|; s|.*from "\./([^"]+)".*|v2/\1|' \
    | sort -u)
  copied=0
  for imp in $imports; do
    base="${imp##*/}"
    if [ ! -f "$DST/v2/$base.ts" ] && [ ! -f "$DST/$base.ts" ] && [ ! -f "$DST/serde_json/$base.ts" ]; then
      if [ -f "$SRC/v2/$base.ts" ]; then cp "$SRC/v2/$base.ts" "$DST/v2/$base.ts"; copied=$((copied+1));
      elif [ -f "$SRC/$base.ts" ]; then cp "$SRC/$base.ts" "$DST/$base.ts"; copied=$((copied+1));
      elif [ -f "$SRC/serde_json/$base.ts" ]; then cp "$SRC/serde_json/$base.ts" "$DST/serde_json/$base.ts"; copied=$((copied+1));
      fi
    fi
  done
  [ "$copied" -eq 0 ] && break
done

count=$(find "$DST" -name "*.ts" | wc -l)
echo "[vendor-codex-types] vendored $count files into $DST"
