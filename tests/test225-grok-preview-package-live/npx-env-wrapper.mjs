#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const observation = {
  envKeys: Object.keys(process.env).sort(),
  env: Object.fromEntries(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))),
};
writeFileSync("/tmp/test225-npx-env.json", JSON.stringify(observation), { mode: 0o600 });
const result = spawnSync("/usr/local/bin/npx", process.argv.slice(2), {
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
