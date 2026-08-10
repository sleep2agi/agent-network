import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
const source = readFileSync(path, "utf8");
const anchor = "if (TERMINAL_STATUSES.has(input.status)) {";
if (source.split(anchor).length - 1 !== 1) throw new Error("expected one terminal precedence anchor");
const mutated = source.replace(anchor, "if (false) {");
if (mutated === source) throw new Error("task diagnostic mutation was byte-identical");
writeFileSync(path, mutated);
