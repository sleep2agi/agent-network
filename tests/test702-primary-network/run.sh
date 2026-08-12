#!/usr/bin/env bash
set -euo pipefail

echo "[test702] source=${TEST702_SOURCE_COMMIT:-unknown}"
echo "[test702] primary-network behavior + CLI wiring"
bun test src/primary-network.test.ts

echo "[test702] TypeScript typecheck"
bun run typecheck

echo "[test702] package build"
bun run build

echo "[test702] PASS"
