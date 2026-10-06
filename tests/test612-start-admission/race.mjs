// Cross-process contest for the start-slot lock. One bun process never trips
// the file lock: enqueueSlot serializes that process. This file spawns several
// independent processes that share a slots directory and cap 1.
// Exit 0 when OVERLAPS is 0. Exit 1 when the mutex broke. A worker crash exits 2.
import { spawn } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKERS = 4;
const ROUNDS = 50;
const HOLD_MS = 5;
const GATE = process.env.RACE_GATE || "/agent-node-src/src/runtime/codex-app-server/start-resource-gate.ts";

async function workerMain(id) {
  const slots = process.env.RACE_SLOTS;
  if (!slots) {
    console.error("FAIL: RACE_SLOTS missing");
    process.exit(2);
  }
  const { waitForStartResources } = await import(GATE);
  const marker = join(slots, ".crit");
  let overlaps = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const gate = await waitForStartResources("race", {
      nodeId: `w${id}r${round}`,
      slotsDir: slots,
      recheckMs: 5,
      jitterMs: 0,
      log: () => {},
      warn: (m) => console.error(m),
      env: {
        ANET_START_MIN_MEM_MB: "1",
        ANET_START_MAX_LOAD_PER_CPU: "1000000",
        ANET_START_MAX_CONCURRENT: "1",
        ANET_START_GATE_MAX_WAIT_SEC: "30",
      },
    });
    let created = false;
    try {
      try {
        const fd = openSync(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        closeSync(fd);
        created = true;
      } catch (e) {
        if (e?.code !== "EEXIST") throw e;
        overlaps++;
      }
      await new Promise((r) => setTimeout(r, HOLD_MS));
    } finally {
      if (created) {
        try { unlinkSync(marker); } catch { /* the next round reports a stuck marker */ }
      }
      gate.release();
    }
  }
  console.log(`OVERLAPS=${overlaps}`);
}

function runWorker(id, slots) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "--worker", String(id)], {
      env: { ...process.env, RACE_SLOTS: slots, RACE_GATE: GATE },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

const workerFlag = process.argv.indexOf("--worker");
if (workerFlag >= 0) {
  await workerMain(process.argv[workerFlag + 1]);
} else {
  const slots = mkdtempSync(join(tmpdir(), "anet-612-race-"));
  let code = 0;
  try {
    const results = await Promise.all(Array.from({ length: WORKERS }, (_, i) => runWorker(i, slots)));
    let total = 0;
    let bad = 0;
    for (const r of results) {
      if (r.err.trim()) console.error(r.err.trim());
      process.stdout.write(r.out);
      const m = /OVERLAPS=(\d+)/.exec(r.out);
      if (r.code !== 0 || !m) bad++;
      else total += Number(m[1]);
    }
    console.log(`OVERLAPS=${total}`);
    code = bad ? 2 : (total === 0 ? 0 : 1);
  } finally {
    rmSync(slots, { recursive: true, force: true });
  }
  process.exit(code);
}
