import { readFileSync, writeFileSync } from "fs";

const [file, before, after] = process.argv.slice(2);
if (!file || before === undefined || after === undefined) throw new Error("usage: mutate.ts FILE BEFORE AFTER");
const source = readFileSync(file, "utf8");
const occurrences = source.split(before).length - 1;
if (occurrences !== 1) throw new Error(`mutation anchor count=${occurrences}, expected=1: ${before}`);
writeFileSync(file, source.replace(before, after));
