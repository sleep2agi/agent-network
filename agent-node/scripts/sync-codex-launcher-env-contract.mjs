#!/usr/bin/env node
// Regenerate agent-node/src/runtime/codex-launcher-env.contract.json from the launcher's
// source of truth. The unit-test image only mounts agent-node, so the test reads the
// checked-in contract instead of reaching across packages at test time.
//
// Usage:
//   node agent-node/scripts/sync-codex-launcher-env-contract.mjs          # write
//   node agent-node/scripts/sync-codex-launcher-env-contract.mjs --check  # fail on drift
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const upstream = join(repo, "agent-network", "src", "codex-copresence-env.ts");
const contract = join(here, "..", "src", "runtime", "codex-launcher-env.contract.json");

const source = readFileSync(upstream, "utf8");
const block = source.match(/const LAUNCHER_ENV = new Set\(\[([\s\S]*?)\]\);/)?.[1];
if (!block) {
  console.error("could not find LAUNCHER_ENV in " + upstream);
  process.exit(2);
}
const names = [...new Set([...block.matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]))].sort();
const next = JSON.stringify({ source: "agent-network/src/codex-copresence-env.ts", names }, null, 2) + "\n";

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(contract, "utf8");
  } catch {}
  if (current !== next) {
    console.error("codex launcher env contract is stale; run: node agent-node/scripts/sync-codex-launcher-env-contract.mjs");
    process.exit(1);
  }
  console.log(`ok: ${names.length} names`);
  process.exit(0);
}

writeFileSync(contract, next);
console.log(`wrote ${contract} (${names.length} names)`);
