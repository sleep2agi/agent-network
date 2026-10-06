// One holder stalls inside the slot count long enough for the lock to be
// reclaimed. Exit 0 when only the new holder keeps the lease. Exit 1 when
// the stalled holder also keeps one. Exit 2 when the harness itself fails.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const GATE = process.env.RACE_GATE || "/agent-node-src/src/runtime/codex-app-server/start-resource-gate.ts";
const HOLDER = 4242;
const Y_PID = 99999;

function slotNames(dir) {
  return readdirSync(dir).filter((name) => name !== ".lock" && !name.startsWith("."));
}

async function childMain() {
  const { waitForStartResources } = await import(GATE);
  const slots = process.argv[3];
  const releaseFlag = process.argv[4];
  const holdingFlag = process.argv[5];
  const deadline = Date.now() + 8000;
  while (!existsSync(join(slots, ".lock"))) {
    if (Date.now() > deadline) {
      console.error("NO_LOCK");
      process.exit(2);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  const mem = "MemTotal:       65642000 kB\nMemAvailable:   20971520 kB\n";
  const r = await waitForStartResources("b", {
    env: { ANET_START_MAX_CONCURRENT: "1", ANET_START_GATE_MAX_WAIT_SEC: "8" },
    platform: "linux",
    cpuCount: () => 16,
    readFile: (p) => p === "/proc/meminfo" ? mem : p === "/proc/loadavg" ? "1.00 1.00 1.00 1/1 1\n" : null,
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: () => Date.now(),
    random: () => 0,
    slotsDir: slots,
    nodeId: "nodeB",
    holderPid: 4343,
    isPidAlive: (pid) => pid === HOLDER || pid === 4343,
    readProcessStartTicks: () => null,
    lockOrphanMs: 300,
    recheckMs: 50,
    jitterMs: 0,
    log: () => {},
    warn: (m) => console.error(m),
  });
  writeFileSync(holdingFlag, "1");
  const end = Date.now() + 8000;
  while (!existsSync(releaseFlag)) {
    if (Date.now() > end) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  r.release();
  console.log("B_DONE");
}

async function parentMain() {
  const { waitForStartResources } = await import(GATE);
  const slotsDir = mkdtempSync(join(tmpdir(), "anet-612-recheck-"));
  const sideDir = mkdtempSync(join(tmpdir(), "anet-612-recheck-side-"));
  const releaseFlag = join(sideDir, "release-b");
  const holdingFlag = join(sideDir, "b-holding");
  writeFileSync(join(slotsDir, "nodeY"), `${Y_PID} - ${Date.now() + 600_000}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "--child", slotsDir, releaseFlag, holdingFlag], {
    env: { ...process.env, RACE_GATE: GATE },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childErr = "";
  child.stderr.on("data", (buf) => { childErr += String(buf); });
  child.stdout.on("data", () => {});
  let checks = 0;
  let gateResult = null;
  const started = Date.now();
  const mem = "MemTotal:       65642000 kB\nMemAvailable:   20971520 kB\n";
  const gateP = waitForStartResources("a", {
    env: { ANET_START_MAX_CONCURRENT: "1", ANET_START_GATE_MAX_WAIT_SEC: "8" },
    platform: "linux",
    cpuCount: () => 16,
    readFile: (p) => p === "/proc/meminfo" ? mem : p === "/proc/loadavg" ? "1.00 1.00 1.00 1/1 1\n" : null,
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: () => Date.now(),
    random: () => 0,
    slotsDir,
    nodeId: "nodeA",
    holderPid: HOLDER,
    recheckMs: 30,
    jitterMs: 0,
    log: () => {},
    warn: (m) => console.error(m),
    readProcessStartTicks: () => null,
    isPidAlive: (pid) => {
      if (pid === Y_PID) {
        checks++;
        if (checks === 1) return true;
        if (checks === 2) {
          const until = Date.now() + 2500;
          while (Date.now() < until) { /* countLiveSlots is inside the lock */ }
          return false;
        }
        return false;
      }
      return pid === HOLDER || pid === 4343;
    },
  }).then((r) => {
    gateResult = r;
    return r;
  });
  let code = 0;
  try {
    const deadline = started + 7000;
    while (Date.now() - started < 3200 || !existsSync(holdingFlag)) {
      if (Date.now() > deadline) break;
      await new Promise((res) => setTimeout(res, 30));
    }
    const names = slotNames(slotsDir);
    const doubled = names.includes("nodeA") && names.includes("nodeB");
    console.log(`DOUBLE=${doubled} LEASES=${names.join(",") || "-"}`);
    if (!existsSync(holdingFlag)) {
      console.error(`FAIL: child did not admit; stderr=${childErr.trim()}`);
      code = 2;
    } else if (doubled || names.includes("nodeA") || !names.includes("nodeB")) {
      console.error(`FAIL: stalled holder still has a lease (${names.join(",")})`);
      code = 1;
    } else {
      writeFileSync(releaseFlag, "1");
      const admitted = await gateP;
      const after = slotNames(slotsDir);
      if (after.length !== 1 || after[0] !== "nodeA") {
        console.error(`FAIL: after B released, leases=${after.join(",") || "-"}`);
        code = 1;
      } else {
        admitted.release();
      }
    }
  } finally {
    try { writeFileSync(releaseFlag, "1"); } catch { /* already gone */ }
    if (!gateResult) {
      await Promise.race([
        gateP.then((r) => { gateResult = r; }),
        new Promise((res) => setTimeout(res, 3000)),
      ]);
    }
    gateResult?.release();
    child.kill("SIGKILL");
    rmSync(slotsDir, { recursive: true, force: true });
    rmSync(sideDir, { recursive: true, force: true });
  }
  process.exit(code);
}

if (process.argv.includes("--child")) await childMain();
else await parentMain();
