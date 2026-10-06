// Same node releases while the directory lock is busy, then starts again at
// once. Exit 0 when that start keeps the slot and a third party stays out.
// Exit 1 when the third party gets in while the restarted node is still up.
// Exit 2 when the harness itself fails.
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE = process.env.RACE_GATE || "/agent-node-src/src/runtime/codex-app-server/start-resource-gate.ts";
const HOLDER = 4242;

function slotNames(dir) {
  return readdirSync(dir).filter((name) => name !== ".lock" && !name.startsWith("."));
}

const { waitForStartResources } = await import(GATE);
const slotsDir = mkdtempSync(join(tmpdir(), "anet-612-reentry-"));
const warns = [];
const mem = "MemTotal:       65642000 kB\nMemAvailable:   20971520 kB\n";
function host(nodeId, holderPid) {
  return {
    env: { ANET_START_MAX_CONCURRENT: "1", ANET_START_GATE_MAX_WAIT_SEC: "30" },
    platform: "linux",
    cpuCount: () => 16,
    readFile: (p) => p === "/proc/meminfo" ? mem : p === "/proc/loadavg" ? "1.00 1.00 1.00 1/1 1\n" : null,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    random: () => 0,
    slotsDir,
    nodeId,
    holderPid,
    recheckMs: 40,
    jitterMs: 0,
    log: () => {},
    warn: (m) => warns.push(m),
    readProcessStartTicks: () => null,
    isPidAlive: (pid) => pid === HOLDER || pid === 88888 || pid === 4343,
  };
}

let code = 0;
try {
  const first = await waitForStartResources("a", host("nodeA", HOLDER));
  if (slotNames(slotsDir).join(",") !== "nodeA") {
    console.error(`FAIL: first admit leases=${slotNames(slotsDir).join(",")}`);
    process.exit(2);
  }
  const lockPath = join(slotsDir, ".lock");
  writeFileSync(lockPath, "88888 111\n", { mode: 0o600 });
  first.release();
  const afterRelease = slotNames(slotsDir).join(",");
  if (afterRelease !== "nodeA" || !warns.join("\n").includes("lock busy; retrying")) {
    console.error(`FAIL: busy release did not keep the lease (${afterRelease})`);
    process.exit(2);
  }
  unlinkSync(lockPath);
  const second = await waitForStartResources("a", host("nodeA", HOLDER));
  if (second.outcome !== "ok" || slotNames(slotsDir).join(",") !== "nodeA") {
    console.error(`FAIL: restart outcome=${second.outcome} leases=${slotNames(slotsDir).join(",")}`);
    code = 2;
  } else {
    let third = null;
    const thirdTask = waitForStartResources("b", host("nodeB", 4343)).then((r) => {
      third = r;
      return r;
    });
    await new Promise((res) => setTimeout(res, 700));
    const names = slotNames(slotsDir);
    const thirdIn = third !== null || names.includes("nodeB") || !names.includes("nodeA");
    console.log(`THIRD_IN=${thirdIn} LEASES=${names.join(",") || "-"}`);
    if (thirdIn) {
      console.error("FAIL: a third party entered while the restarted node was still up");
      code = 1;
    } else {
      second.release();
      const admitted = await thirdTask;
      const after = slotNames(slotsDir);
      if (!after.includes("nodeB") || after.includes("nodeA")) {
        console.error(`FAIL: after release leases=${after.join(",") || "-"} outcome=${admitted.outcome}`);
        code = 1;
      } else {
        admitted.release();
      }
    }
  }
} catch (e) {
  console.error(`FAIL: ${e instanceof Error ? e.stack : String(e)}`);
  code = 2;
} finally {
  rmSync(slotsDir, { recursive: true, force: true });
}
process.exit(code);
