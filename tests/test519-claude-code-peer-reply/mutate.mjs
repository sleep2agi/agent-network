// Replace exactly one occurrence of an anchor; refuse when it is absent or ambiguous.
import { readFileSync, writeFileSync } from "node:fs";
const [file, before, after] = process.argv.slice(2);
const src = readFileSync(file, "utf-8");
const count = src.split(before).length - 1;
if (count !== 1) { console.error(`mutation anchor count ${count} != 1: ${JSON.stringify(before)}`); process.exit(2); }
writeFileSync(file, src.replace(before, after));
