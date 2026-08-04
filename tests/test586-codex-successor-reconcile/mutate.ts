import { readFileSync, writeFileSync } from "node:fs";

if (process.argv[2] !== "aggregate_active_shortcut") {
  throw new Error(`unknown mutation: ${process.argv[2]}`);
}

const path = "./src/runtime/codex-app-server-bridge.ts";
const source = readFileSync(path, "utf8");
const anchor = `        forceFullHistory ||\n`;
const matches = source.split(anchor).length - 1;
if (matches !== 1) throw new Error(`expected one anchor, got ${matches}`);
writeFileSync(path, source.replace(anchor, `        false ||\n`));
