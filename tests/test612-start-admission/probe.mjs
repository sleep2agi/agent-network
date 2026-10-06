// Real start gate under a Docker --memory limit. No injected meminfo,
// platform, or clock. recheckMs only shortens the sleep between tries.
import { readdirSync, readFileSync, rmSync } from "node:fs";
import {
  waitForStartResources,
  START_GATE_SINGLE_LANE_STATUS,
  START_GATE_WAITING_STATUS,
} from "/agent-node-src/src/runtime/codex-app-server/start-resource-gate.ts";

const N = 14;
const HOLD_MS = 100;
const SLOTS = "/tmp/test612-slots";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function cgroupMaxFile() {
  const text = readFileSync("/proc/self/cgroup", "utf8");
  let rel = null;
  let v1 = false;
  for (const line of text.split(/\r?\n/)) {
    const v2 = /^0::(.*)$/.exec(line.trim());
    if (v2) {
      rel = v2[1] || "/";
      break;
    }
  }
  if (rel === null) {
    for (const line of text.split(/\r?\n/)) {
      const m = /^\d+:memory:(.*)$/.exec(line.trim());
      if (m) {
        rel = m[1] || "/";
        v1 = true;
        break;
      }
    }
  }
  if (rel === null || rel.includes("..") || rel.includes("\0")) return null;
  if (!rel.startsWith("/")) rel = `/${rel}`;
  const base = v1
    ? `/sys/fs/cgroup/memory${rel === "/" ? "" : rel}`
    : `/sys/fs/cgroup${rel === "/" ? "" : rel}`;
  return v1 ? `${base}/memory.limit_in_bytes` : `${base}/memory.max`;
}

const maxFile = cgroupMaxFile();
if (!maxFile) fail("no cgroup memory file from /proc/self/cgroup");
const maxText = readFileSync(maxFile, "utf8").trim();
const maxBytes = Number(maxText);
console.log(`cgroup_max_file=${maxFile} cgroup_max=${maxText}`);
if (!Number.isFinite(maxBytes) || maxBytes <= 0 || maxBytes > 1024 * 1024 * 1024) {
  fail(`memory.max is not a small limit (got ${JSON.stringify(maxText)}). The container must be started with --memory.`);
}

delete process.env.ANET_START_MEM_GATE;
delete process.env.ANET_START_MIN_MEM_MB;
process.env.ANET_START_SLOTS_DIR = SLOTS;
process.env.ANET_START_GATE_MAX_WAIT_SEC = "0.4";
process.env.ANET_START_MAX_CONCURRENT = String(N);
process.env.ANET_START_MAX_LOAD_PER_CPU = "1000000";
rmSync(SLOTS, { recursive: true, force: true });

const logs = [];
const reports = [];
let starting = 0;
let maxStarting = 0;

const jobs = Array.from({ length: N }, (_, i) => (async () => {
  let result;
  let held = false;
  try {
    result = await waitForStartResources("codex app-server", {
      nodeId: `n_${i}`,
      recheckMs: 25,
      jitterMs: 0,
      log: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      report: (text) => reports.push(text),
    });
    held = true;
    starting += 1;
    if (starting > maxStarting) maxStarting = starting;
    await new Promise((r) => setTimeout(r, HOLD_MS));
    return result;
  } finally {
    if (held) starting -= 1;
    result?.release();
  }
})());

let settled;
try {
  settled = await Promise.race([
    Promise.allSettled(jobs),
    new Promise((_, reject) => setTimeout(() => reject(new Error("probe exceeded 30s")), 30_000)),
  ]);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

const rejected = settled.filter((s) => s.status === "rejected");
if (rejected.length) {
  fail(`${rejected.length} start(s) threw: ${rejected[0].reason}`);
}
const outcomes = settled.map((s) => s.value.outcome);
console.log(`maxStarting=${maxStarting} outcomes=${outcomes.join(",")}`);
for (const line of logs) console.log(line);

const tighter = logs.map((line) => /cgroup (\d+) MiB tighter than MemAvailable (\d+) MiB/.exec(line)).find(Boolean);
if (!tighter) fail("gate log never said the cgroup was tighter than MemAvailable; it did not read the cgroup");
const cgroupMb = Number(tighter[1]);
const procMb = Number(tighter[2]);
console.log(`cgroup_free_mib=${cgroupMb} proc_available_mib=${procMb}`);
if (!(cgroupMb < 1024 && procMb > cgroupMb + 256)) {
  fail(`cgroup ${cgroupMb} MiB is not a tight limit under a larger MemAvailable ${procMb} MiB`);
}
if (reports.filter((t) => t === START_GATE_WAITING_STATUS).length !== N) {
  fail(`waiting status count ${reports.filter((t) => t === START_GATE_WAITING_STATUS).length}, expected ${N}`);
}
if (reports.filter((t) => t === START_GATE_SINGLE_LANE_STATUS).length !== N) {
  fail(`single-lane status count ${reports.filter((t) => t === START_GATE_SINGLE_LANE_STATUS).length}, expected ${N}`);
}
if (!outcomes.every((o) => o === "single-lane")) fail(`outcomes were not all single-lane: ${outcomes.join(",")}`);
if (maxStarting !== 1) fail(`maxStarting=${maxStarting} expected 1`);
const left = readdirSync(SLOTS).filter((name) => name !== ".lock");
if (left.length) fail(`leases still held: ${left.join(",")}`);
console.log("OK maxStarting=1");
