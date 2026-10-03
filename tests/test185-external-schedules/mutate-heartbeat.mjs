import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
const source = readFileSync(path, "utf8");
// #520: both heartbeat call sites gained an options object (owner schedule
// control), so the anchor now spans the whole multi-line property.
const anchor = "    external_schedules: readExternalSchedulesSnapshot(configFilePath, undefined, {\n      ownerControlEnabled: OWNER_SCHEDULE_CONTROL_ENABLED,\n      ownerNodeId: NODE_ID || undefined,\n    }),\n";
const matches = source.split(anchor).length - 1;
if (matches !== 2) throw new Error(`expected two heartbeat anchors, found ${matches}`);
const mutated = source.split(anchor).join("");
if (mutated === source) throw new Error("heartbeat mutation was byte-identical");
writeFileSync(path, mutated);
