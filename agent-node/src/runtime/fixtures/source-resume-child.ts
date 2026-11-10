// Test-only synthetic CLI child. Not an upstream OpenCode binary or native E2E.
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { openSourceResumeRuntime, publishSourceResumeHealth } from "../source-resume-launcher";
if (process.argv.includes("--help")) { console.log("Synthetic fixture ANET_CAPABILITY_SOURCE_RESUME_V1"); process.exit(0); }
const path = process.env.ANET_SOURCE_RESUME_CONFIG!;
if (process.argv.slice(2).join(" ") !== `node start ${basename(dirname(path))}`) throw Error("fixture argv mismatch");
const c = JSON.parse(readFileSync(path, "utf8"));
const runtime = await openSourceResumeRuntime({ configPath: path, cwd: process.cwd(),
  nonce: process.env.ANET_SOURCE_RESUME_NONCE!, binary: process.execPath, expectedVersion: "2.0.22",
  sessionId: c.sessionId, newSession: false, nodeId: c.node_id, model: c.model });
const registered = await fetch(`${c.hub}/fixture-register`, { method: "POST",
  headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
  body: JSON.stringify({ node_id: c.node_id, alias: c.alias, session_id: runtime.sessionId, bridge_pid: process.pid }) });
if (!registered.ok) { await runtime.close(); process.exit(1); }
if (process.env.SOURCE_TEST_DROP_HEALTH !== "1") publishSourceResumeHealth(path, process.env.ANET_SOURCE_RESUME_NONCE!, runtime.sessionId);
const keep = setInterval(() => {}, 1000);
const stop = async () => { clearInterval(keep); await runtime.close(); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
