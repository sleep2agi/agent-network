import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("usage: mutate.mjs <rest-projections.ts>");

const source = readFileSync(path, "utf8");
const anchor = '  "created_at", "delivered_at", "started_at", "runtime_submitted_at", "consumed_at", "completed_at", "expires_at",';
const replacement = '  "delivered_at", "started_at", "runtime_submitted_at", "consumed_at", "completed_at", "expires_at",';
if (source.split(anchor).length - 1 !== 1) {
  throw new Error("expected exactly one task created_at projection anchor");
}
const mutated = source.replace(anchor, replacement);
if (mutated === source) throw new Error("projection mutation was byte-identical");
writeFileSync(path, mutated);
