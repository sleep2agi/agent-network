#!/usr/bin/env bash
set -euo pipefail
# Run with --network none: only an isolated loopback synthetic Provider is used.
bun test agent-node/src/runtime/opencode-v2-model-depth.test.ts agent-node/src/runtime/opencode-v2-catalog.test.ts \
  agent-node/src/runtime/opencode-copresence/variant-config-apply.test.ts \
  agent-node/src/runtime/opencode-copresence/wrapper-model-switch.test.ts
python3 tests/test4822-model-depth/probe.py
