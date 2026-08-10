#!/usr/bin/env bash
set -euo pipefail

ROOT=/workspace
ARTIFACT_DIR=/artifacts
mkdir -p "$ARTIFACT_DIR"
REPORT="$ARTIFACT_DIR/report-test520-dashboard-attachment-read.txt"
exec > >(tee "$REPORT") 2>&1

echo "source_commit=$TEST520_ATTACHMENT_SOURCE_COMMIT"
echo "layer=authenticated Hub file download -> real Claude channel + readable runtime prompt"

cd "$ROOT/agent-network"
bun run typecheck
bun build src/node-server.ts --outfile /tmp/test520-node-server.js --target node
bun test src/channel-attachments.test.ts

cd "$ROOT/agent-node"
bun run build
bun test src/runtime/readable-attachment-prompt.test.ts src/task-runtime-evidence.test.ts

cd "$ROOT"
CHANNEL_BUNDLE=/tmp/test520-node-server.js bun tests/test520-dashboard-attachment-read/channel-harness.ts

MUTATIONS=0
expect_mutation_red() {
  local name=$1 file=$2 before=$3 after=$4 command=$5
  local backup
  backup=$(mktemp)
  cp "$file" "$backup"
  bun tests/test520-dashboard-attachment-read/mutate.mjs "$file" "$before" "$after"
  if cmp -s "$file" "$backup"; then
    echo "MUTATION INVALID byte-identical: $name" >&2
    exit 1
  fi
  set +e
  bash -lc "$command" >/tmp/test520-attachment-mutation.log 2>&1
  local rc=$?
  set -e
  cp "$backup" "$file"
  rm -f "$backup"
  if [[ $rc -eq 0 ]]; then
    echo "MUTATION SURVIVED: $name" >&2
    cat /tmp/test520-attachment-mutation.log >&2
    exit 1
  fi
  MUTATIONS=$((MUTATIONS + 1))
  echo "MUTATION RED: $name rc=$rc"
}

expect_mutation_red \
  claude-channel-path-injection \
  agent-network/src/node-server.ts \
  'content: channelContent,' \
  'content: msg.content,' \
  'cd /workspace/agent-network && bun build src/node-server.ts --outfile /tmp/test520-mut-node-server.js --target node >/dev/null && cd /workspace && CHANNEL_BUNDLE=/tmp/test520-mut-node-server.js bun tests/test520-dashboard-attachment-read/channel-harness.ts'

expect_mutation_red \
  readable-runtime-path-injection \
  agent-node/src/cli.ts \
  'appendReadableAttachmentPaths(content, images)' \
  'content' \
  'cd /workspace/agent-node && bun test src/runtime/readable-attachment-prompt.test.ts'

expect_mutation_red \
  structured-image-lane-isolation \
  agent-node/src/runtime/readable-attachment-prompt.ts \
  $'  "opencode",\n]);' \
  $'  "opencode",\n  "claude",\n]);' \
  'cd /workspace/agent-node && bun test src/runtime/readable-attachment-prompt.test.ts'

expect_mutation_red \
  sender-local-path-rejection \
  agent-network/src/channel-attachments.ts \
  'return { ok: false, code: "no_download_identity", message: "attachment has no usable file_id" };' \
  'return { ok: true, path: String(attachment.path || "") };' \
  'cd /workspace/agent-network && bun test src/channel-attachments.test.ts'

if [[ $MUTATIONS -ne 4 ]]; then
  echo "mutation denominator mismatch: $MUTATIONS/4" >&2
  exit 1
fi
echo "mutation_red=$MUTATIONS/4"
echo "RESULT: PASS"
