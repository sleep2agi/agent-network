#!/bin/sh
set -eu
# Environment/persistence before authenticated dispatch and real startup.
bun test --bail agent-network/src/scoped-secrets.test.ts
bun test --bail tests/test1053-scoped-secrets/hub-runtime.test.ts
