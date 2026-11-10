#!/bin/sh
set -eu
bun test --bail tests/test1075-node-secrets/wire.test.ts
bun test --bail tests/test1075-node-secrets/core.test.ts
