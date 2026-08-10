import { readFileSync, writeFileSync } from "node:fs";

const [file, before, after] = process.argv.slice(2);
if (!file || before === undefined || after === undefined) {
  throw new Error("usage: mutate.mjs FILE BEFORE AFTER");
}
const source = readFileSync(file, "utf8");
const count = source.split(before).length - 1;
if (count !== 1) throw new Error(`mutation anchor count=${count} file=${file}`);
const mutated = source.replace(before, after);
if (mutated === source) throw new Error(`mutation was byte-identical file=${file}`);
writeFileSync(file, mutated);
