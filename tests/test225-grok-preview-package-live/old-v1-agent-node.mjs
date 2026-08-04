#!/usr/bin/env node
import { writeFileSync } from "node:fs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write([
    "legacy test-only agent-node",
    "grok-build-cli",
    "ANET_CAPABILITY_GROK_COPRESENCE_V1",
    "",
  ].join("\n"));
  process.exit(0);
}

writeFileSync("/tmp/test225-old-v1-agent-node-launched", "unexpected\n", { mode: 0o600 });
process.exit(97);
