import { readFileSync, writeFileSync } from "node:fs";

const [file, before, after] = process.argv.slice(2);
if (!file || before === undefined || after === undefined) throw new Error("file/before/after required");
const source = readFileSync(file, "utf8");
const count = source.split(before).length - 1;
if (count !== 1) throw new Error(`anchor count=${count} expected=1`);
writeFileSync(file, source.replace(before, after));
