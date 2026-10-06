#!/bin/sh
set -eu
printf 'source_commit=%s\n' "$SOURCE_COMMIT"
bun test ./agent-node/src/runtime/adopt-codex-evidence.test.ts ./tests/test658-codex-adopt-stop/collect.test.ts
bun test ./agent-node/src/runtime/adopt-codex-start-inputs.test.ts ./tests/test658-codex-adopt-stop/start-preflight.test.ts
bun run tests/test658-codex-adopt-stop/start-mutation.ts
exec bun run tests/test658-codex-adopt-stop/mutation.ts
