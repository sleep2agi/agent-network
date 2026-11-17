// Execute with private Node, not Bun. Reproduce daemon -> stop CLI -> helper,
// including the product minimalEnv builder and execFile's private stdio pipes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { minimalEnv } from "../../agent-node/src/runtime/create-node-daemon.js";
import { openWindowsSdkEvidenceSession } from "../../agent-network/src/windows-sdk-stop-evidence.js";
import { probeWindowsCreationDate } from "../../agent-network/src/windows-codex-copresence.js";

assert.equal(process.platform, "win32");
assert(!process.versions.bun, "helper probe must use actual private Node");
if (process.argv[2] !== "--child") {
  const env = minimalEnv();
  console.log(JSON.stringify({ helper_probe: "product_env", runtime: "node", present: Object.fromEntries(
    ["SystemRoot", "windir", "TEMP", "TMP", "HOME", "USERPROFILE", "PSModulePath"].map(key => [key, !!env[key]])) }));
  try {
    const result = await promisify(execFile)(process.execPath, [process.argv[1], "--child"], {
      cwd: process.cwd(), env, shell: false, windowsHide: true, timeout: 55_000, maxBuffer: 64 * 1024,
    });
    process.stdout.write(result.stdout);
  } catch (error: any) {
    // Child only emits fixed-shape diagnostics; never dump execFile error argv/env.
    process.stdout.write(String(error.stdout ?? ""));
    const safe = String(error.stderr ?? "").split(/\r?\n/).filter(line => line.startsWith("SDK evidence") || line.startsWith("[helper-probe]"));
    console.error(safe.join("\n") || "[helper-probe] child_failed");
    process.exitCode = 1;
  }
} else {
  try {
    const at = Date.now();
    const birth = probeWindowsCreationDate(process.pid);
    console.log(`[helper-probe] reference_birth_ms=${Date.now() - at}`);
    assert(birth, "reference birth unavailable");
    const root = { pid: process.pid, role: "probe", creationDate: birth };
    const session = await openWindowsSdkEvidenceSession({ onProgress: text => console.log(`[helper-probe] ${text}`) });
    try {
      assert.equal((await session.deps.captureRoots!([root]))[0].unknownReason, undefined);
      assert.equal(await session.deps.probeRoot!(root), "alive");
      assert.equal((await session.deps.readFinalEvidence!([root])).probe(root), "alive");
      console.log("[helper-probe] product_env_node_chain_ok");
    } finally { session.close(); }
  } catch (error: any) {
    // Evidence session errors are fixed-shape; assertions get a constant reason.
    console.error(String(error.message).startsWith("SDK evidence") ? error.message : "[helper-probe] evidence_verification_failed");
    process.exitCode = 1;
  }
}
