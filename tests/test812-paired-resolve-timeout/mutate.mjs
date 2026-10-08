import { readFileSync, writeFileSync } from "node:fs";
const path = "agent-network/bin/cli.ts";
const source = readFileSync(path, "utf8");
const before = "timeout: resolveTimeoutMs, env: probeEnv";
if (source.split(before).length !== 2) throw Error("mutation anchor must be unique");
writeFileSync(path, source.replace(before, "timeout: 120_000, env: probeEnv"));
