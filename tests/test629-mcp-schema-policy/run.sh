#!/usr/bin/env bash
set -euo pipefail

cd /workspace/server
echo "# test629 — MCP unknown-field policy audit"
echo "source_commit=${TEST629_SOURCE_COMMIT}"
bun test629/probe.ts
echo "RESULT: PASS"
