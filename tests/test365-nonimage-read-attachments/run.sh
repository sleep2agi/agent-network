#!/usr/bin/env bash
set -euo pipefail

ROOT=/workspace
WORK=/tmp/test365
source "$ROOT/tests/lib/safe-rm.sh"
safe_rm_rf "$WORK"
mkdir -p "$WORK/home" "$WORK/uploads"
export HOME="$WORK/home"

echo "source_commit=$TEST365_SOURCE_COMMIT"
echo "layer=real Hub file_id PDF -> real Claude channel Read path"

cd "$ROOT/agent-network"
bun run typecheck
bun build src/node-server.ts --outfile "$WORK/node-server.js" --target node
bun test src/channel-attachments.test.ts

cd "$ROOT/agent-node"
bun run build
bun test src/runtime/fetch-attachment.test.ts src/runtime/readable-attachment-prompt.test.ts

cd "$ROOT"
PORT=9365 HOST=127.0.0.1 NODE_ENV=test \
  COMMHUB_DB="$WORK/hub.db" COMMHUB_UPLOADS_ROOT="$WORK/uploads" \
  bun run server/src/index.ts >"$WORK/hub.log" 2>&1 &
HUB_PID=$!
cleanup() {
  kill "$HUB_PID" 2>/dev/null || true
  wait "$HUB_PID" 2>/dev/null || true
}
trap cleanup EXIT
for _ in $(seq 1 80); do curl -fsS http://127.0.0.1:9365/health >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS http://127.0.0.1:9365/health >/dev/null
CHANNEL_BUNDLE="$WORK/node-server.js" HUB_BASE=http://127.0.0.1:9365 \
  bun tests/test365-nonimage-read-attachments/real-hub-channel-harness.ts

MUTATIONS=0
expect_red() {
  local name=$1 file=$2 before=$3 after=$4 command=$5
  local backup="$WORK/$(basename "$file").$MUTATIONS.bak"
  cp "$file" "$backup"
  bun tests/test365-nonimage-read-attachments/mutate.mjs "$file" "$before" "$after"
  ! cmp -s "$file" "$backup" || { echo "MUTATION INVALID byte-identical: $name" >&2; exit 1; }
  set +e
  bash -lc "$command" >"$WORK/mutation.log" 2>&1
  local rc=$?
  set -e
  cp "$backup" "$file"
  if [[ $rc -eq 0 ]]; then
    echo "MUTATION SURVIVED: $name" >&2
    cat "$WORK/mutation.log" >&2
    exit 1
  fi
  MUTATIONS=$((MUTATIONS + 1))
  echo "WITNESSED-RED $name rc=$rc"
}

expect_red \
  channel-restores-image-only-filter \
  agent-network/src/channel-attachments.ts \
  '    attachment && typeof attachment === "object"' \
  '    attachment && typeof attachment === "object" && (attachment.type === "image" || String(attachment.mime || "").startsWith("image/"))' \
  'cd /workspace/agent-network && bun test src/channel-attachments.test.ts'

expect_red \
  path-runtime-restores-image-only-filter \
  agent-node/src/runtime/readable-attachment-prompt.ts \
  $'    return attachments.filter((attachment) =>\n      typeof attachment.file_id === "string" && attachment.file_id.length > 0\n      && isAllowlistedReadableAttachment(attachment));' \
  $'    return attachments.filter((attachment) =>\n      (attachment.type === "image" || String(attachment.mime || "").startsWith("image/"))\n      && typeof attachment.file_id === "string" && attachment.file_id.length > 0\n      && isAllowlistedReadableAttachment(attachment));' \
  'cd /workspace/agent-node && bun test src/runtime/readable-attachment-prompt.test.ts'

expect_red \
  structured-runtime-accepts-nonimage \
  agent-node/src/runtime/readable-attachment-prompt.ts \
  $'  return attachments.filter((attachment) =>\n    (attachment.type === "image" || String(attachment.mime || "").startsWith("image/"))\n    && (typeof attachment.file_id === "string" || typeof attachment.path === "string"));' \
  '  return [...attachments];' \
  'cd /workspace/agent-node && bun test src/runtime/readable-attachment-prompt.test.ts'

expect_red \
  channel-extension-allowlist-weakened \
  agent-network/src/channel-attachments.ts \
  '    if (READABLE_EXTENSION_SET.has(extension)) return extension;' \
  '    if (extension.length > 0) return extension;' \
  'cd /workspace/agent-network && bun test src/channel-attachments.test.ts'

expect_red \
  runtime-extension-allowlist-weakened \
  agent-node/src/runtime/readable-attachment-prompt.ts \
  '  return READABLE_EXTENSION_SET.has(extension);' \
  '  return extension.length > 0;' \
  'cd /workspace/agent-node && bun test src/runtime/readable-attachment-prompt.test.ts'

expect_red \
  sender-path-enters-read-prompt \
  agent-node/src/runtime/readable-attachment-prompt.ts \
  '      typeof attachment.file_id === "string" && attachment.file_id.length > 0' \
  '      (typeof attachment.file_id === "string" || typeof attachment.path === "string")' \
  'cd /workspace/agent-node && bun test src/runtime/readable-attachment-prompt.test.ts'

[[ $MUTATIONS -eq 6 ]] || { echo "mutation denominator mismatch: $MUTATIONS/6" >&2; exit 1; }
echo "MUTATION RESULT: PASS=$MUTATIONS FAIL=0"
echo "RESULT: PASS"
