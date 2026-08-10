import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
const source = readFileSync(path, "utf8");
const anchor = "    external_schedules: readExternalSchedulesSnapshot(configFilePath),\n";
const matches = source.split(anchor).length - 1;
if (matches !== 2) throw new Error(`expected two heartbeat anchors, found ${matches}`);
const mutated = source.split(anchor).join("");
if (mutated === source) throw new Error("heartbeat mutation was byte-identical");
writeFileSync(path, mutated);
