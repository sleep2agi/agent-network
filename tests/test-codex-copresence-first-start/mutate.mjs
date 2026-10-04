// Replace exactly one occurrence of BEFORE with AFTER in FILE; anything else is an error
// (a mutation whose anchor drifted must not silently become a no-op).
import { readFileSync, writeFileSync } from "node:fs";
const [file, before, after] = process.argv.slice(2);
if (!file || before === undefined || after === undefined) throw new Error("usage: mutate.mjs FILE BEFORE AFTER");
const src = readFileSync(file, "utf8");
const n = src.split(before).length - 1;
if (n !== 1) throw new Error(`MUTATION_ANCHOR count=${n}, expected 1: ${before}`);
writeFileSync(file, src.replace(before, after));
