#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--help") {
  console.log("agent-node runtimes: claude-agent-sdk | codex-sdk | opencode-cli");
  process.exit(0);
}
if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
  console.log("agent-node v2.5.0-preview.21");
  process.exit(0);
}

writeFileSync("/tmp/test386-stale-capable-global-was-launched", "yes\n");
process.exit(92);
