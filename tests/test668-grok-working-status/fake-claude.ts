#!/usr/bin/env bun
// Stand-in for the `claude` binary. It holds one turn so a claude-agent-sdk
// node stays inside processTask. It does not talk to a model.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const versionOnly = args.length > 0 && args.every((arg) =>
  arg === "--version" || arg === "-v" || arg === "version" || arg === "--help" || arg === "-h"
);
if (versionOnly) {
  process.stdout.write("claude 0.0.0-fake\n");
  process.exit(0);
}

const holdDir = process.env.CLAUDE_FAKE_HOLD_DIR || "/tmp/claude-fake-hold";
mkdirSync(holdDir, { recursive: true });
writeFileSync(`${holdDir}/holding`, "1");
process.stdin.resume();
while (!existsSync(`${holdDir}/release`)) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
process.exit(0);
