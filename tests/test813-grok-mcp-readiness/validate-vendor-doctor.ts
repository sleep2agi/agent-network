import { readFileSync } from "fs";
import { assertGrokCommhubMcpDoctor } from "../../agent-node/src/runtime/grok-build-cli-home";

const path = process.argv[2];
if (!path) throw new Error("VENDOR_DOCTOR_PATH_MISSING");
const raw = readFileSync(path, "utf8");
assertGrokCommhubMcpDoctor(raw);
const report = JSON.parse(raw);
const server = report.servers.find((candidate: any) => candidate?.name === "commhub");
const labels = (server?.checks || [])
  .filter((check: any) => check?.passed === true)
  .map((check: any) => check?.label);
process.stdout.write(`VENDOR_DOCTOR_PASS labels=${labels.join("|")}\n`);
