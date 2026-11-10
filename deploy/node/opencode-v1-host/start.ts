#!/usr/bin/env bun
// Explicit Host Owner entry; never imported by a borrowing node/daemon.
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolvePinnedOpencodeBinaryAttestation } from "../../../agent-node/src/runtime/opencode-acp/binary";
import { startOwnedV1Host, V1HostStartupCancelledError } from "../../../agent-node/src/runtime/opencode-copresence/v1-host-supervisor";

const { values } = parseArgs({ options: {
  root: { type: "string" }, binary: { type: "string" }, version: { type: "string" },
  "host-id": { type: "string" }, cohort: { type: "string" }, port: { type: "string" },
  "scoped-commhub-mcp": { type: "boolean", default: false },
}, strict: true });
const controller = new AbortController();
let host: Awaited<ReturnType<typeof startOwnedV1Host>> | undefined;
async function stop() {
  controller.abort();
  if (!host) return; // Startup observes cancellation and cleans its own child.
  try { await host.close(); process.exit(0); }
  catch { console.error("V1 host cleanup incomplete; retain private root for Owner recovery"); process.exit(1); }
}
process.once("SIGTERM", stop); process.once("SIGINT", stop);
for (const key of ["root", "binary", "version", "host-id", "cohort", "port"] as const) {
  if (!values[key]) throw Error(`missing --${key}`);
}
// Existing private root is an explicit Owner choice; no home/config inference.
const root = realpathSync(values.root!);
const probeRoot = mkdtempSync(join(tmpdir(), "anet-v1-host-probe-"));
const probeEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: probeRoot, OPENCODE_DISABLE_AUTOUPDATE: "1" };
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "OPENCODE_TEST_MANAGED_CONFIG_DIR"]) {
  probeEnv[key] = join(probeRoot, key); mkdirSync(probeEnv[key]!, { mode: 0o700 });
}
let attestation;
try { attestation = resolvePinnedOpencodeBinaryAttestation({ requestedBinary: values.binary!, expectedVersion: values.version!, probeEnv, probeCwd: probeRoot, forbiddenRoots: [root] }); }
finally { rmSync(probeRoot, { recursive: true, force: true }); }
try {
  host = await startOwnedV1Host({ root, hostId: values["host-id"]!, cohortId: values.cohort!, version: values.version!, port: Number(values.port), attestation, signal: controller.signal,
    scopedCommhubMcp: values["scoped-commhub-mcp"] });
} catch (error) { if (error instanceof V1HostStartupCancelledError) process.exit(0); throw error; }
if (controller.signal.aborted) await stop();
console.log(JSON.stringify({ kind: "v1-host-ready", hostId: host.record.hostId, instanceId: host.record.instanceId,
  version: host.record.version, url: host.record.url, pid: host.pid, registry: join(root, "registry.json") }));
