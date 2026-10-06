#!/bin/sh
set -eu
printf 'source_commit=%s\n' "$SOURCE_COMMIT"
bun test ./agent-node/src/runtime/adopt-codex-evidence.test.ts ./tests/test658-codex-adopt-stop/collect.test.ts
exec bun run tests/test658-codex-adopt-stop/mutation.ts
