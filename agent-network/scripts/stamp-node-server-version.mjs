#!/usr/bin/env node
// #549 — stamp dist/src/node-server.js with a machine-readable version marker
// so `anet node start` / `anet resume` can refuse to downgrade a newer
// `.anet/node-server.js`. Runs AFTER javascript-obfuscator (which strips
// comments). Marker format is owned by src/node-server-version.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PREFIX = "// anet-node-server-version: ";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] || join(root, "dist", "src", "node-server.js");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`stamp-node-server-version: package.json version is not semver: ${version}`);
  process.exit(1);
}
let body = readFileSync(target, "utf-8");
// Replace any stale marker rather than stacking a second one.
body = body.split("\n").filter((line, i) => !(i < 5 && line.startsWith(PREFIX))).join("\n");
const marker = `${PREFIX}${version}\n`;
if (body.startsWith("#!")) {
  const nl = body.indexOf("\n");
  body = nl === -1 ? `${body}\n${marker}` : body.slice(0, nl + 1) + marker + body.slice(nl + 1);
} else {
  body = marker + body;
}
writeFileSync(target, body);
console.log(`stamped ${target} with ${version}`);
