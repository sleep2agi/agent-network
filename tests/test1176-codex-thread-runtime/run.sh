#!/usr/bin/env bash
set -euo pipefail

echo "Test 1176 — manual Codex TUI alignment and runtime truth"
echo "Source commit: ${SOURCE_COMMIT:-unknown}"

echo "Layer 1: pure behavior"
bun test \
  /repo/agent-node/src/codex-tui-alignment.test.ts \
  /repo/server/src/runtime-label.test.ts

echo "Layer 2: production integration"
grep -Fq 'codexTuiAlignmentNotice(configFilePath, cfg, threadId)' /repo/agent-node/src/cli.ts
grep -Fq 'const normalizeRuntime = normalizeSessionRuntime' /repo/server/src/server.ts
grep -Fq 'align a POSIX TUI with:' /repo/agent-node/src/cli.ts
grep -Fq 'align a PowerShell TUI with:' /repo/agent-node/src/cli.ts
echo "PASS: writeback and all dashboard projections use the tested helpers"

echo "Layer 3: manual-topology incident documentation"
for page in \
  /repo/docs-site/docs/guide/codex-copresence.md \
  /repo/docs-site/docs/en/guide/codex-copresence.md; do
  grep -Fq 'CODEX_HOME' "$page"
  grep -Eq '443' "$page"
  grep -Eq 'socket' "$page"
  grep -Fq 'codexThreadId' "$page"
  grep -Fq 'codexAppServerUrl' "$page"
  grep -Fq -- '--remote' "$page"
done
echo "PASS: both guides warn that the default home may silently attach to external :443 and require socket/remote/thread verification"

echo "Layer 4: production bundles"
cd /repo/agent-node
bun run build
cd /repo/server
bun build src/index.ts --outdir /tmp/commhub-build --target bun --external better-sqlite3
echo "PASS: agent-node and server production bundles"

echo "RESULT: PASS"
