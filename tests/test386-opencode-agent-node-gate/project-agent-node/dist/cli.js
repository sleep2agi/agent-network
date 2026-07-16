#!/usr/bin/env node
import { writeFileSync } from "node:fs";

writeFileSync("/tmp/test386-project-agent-node-was-executed", "yes\n");
if (process.argv.length === 3 && process.argv[2] === "--help") {
  console.log("agent-node runtimes: claude-agent-sdk | codex-sdk | opencode-cli");
  process.exit(0);
}
process.exit(94);
