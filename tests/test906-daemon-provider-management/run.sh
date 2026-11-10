#!/bin/sh
set -eu
bun test agent-network/src/daemon-provider-store.test.ts
bun test agent-network/src/private-state.test.ts
bun test agent-network/src/daemon-provider-application.test.ts
bun test agent-network/src/daemon-provider-account-readback.test.ts
bun test agent-network/src/daemon-provider-apply-command.test.ts
bun test agent-network/src/codex-copresence-login-gate.test.ts
bun test agent-network/src/codex-lifecycle-facts.test.ts agent-network/src/codex-lifecycle-preflight.test.ts
bun test agent-network/src/codex-copresence-rpc.test.ts
