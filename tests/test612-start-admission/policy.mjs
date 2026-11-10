import {
  START_GATE_DEFAULT_MAX_LOAD_PER_CPU,
  START_GATE_WAITING_BOTH_STATUS,
  START_GATE_WAITING_LOAD_STATUS,
  START_GATE_WAITING_PROBE_STATUS,
  START_GATE_WAITING_STATUS,
  isStartGateBlockedStatus,
  startGateReasons,
  startGateWaitingStatus,
} from "/agent-node-src/src/runtime/codex-app-server/start-resource-gate.ts";

const sample = (memAvailableMb, load1, cpuCount) => ({
  memAvailableMb,
  procAvailableMb: memAvailableMb,
  cgroupFreeMb: null,
  cgroupLimitMb: null,
  memTotalMb: 64 * 1024,
  load1,
  cpuCount,
});

function assert(ok, message) {
  if (!ok) throw new Error(`POLICY_FAIL: ${message}`);
}

assert(START_GATE_DEFAULT_MAX_LOAD_PER_CPU === 4, "default load multiplier is not 4");
assert(startGateReasons(sample(20 * 1024, 9.81, 4), 4096, 4).length === 0, "CI shape was blocked");
assert(startGateReasons(sample(20 * 1024, 24, 8), 4096, 4).length === 0, "DEV shape was blocked");
assert(startGateReasons(sample(20 * 1024, 65, 16), 4096, 4).length === 1, "extreme load was admitted");
assert(startGateReasons(sample(300, 1, 16), 4096, 4).length === 1, "low memory was admitted");
assert(startGateWaitingStatus(sample(300, 1, 16), 4096, 4) === START_GATE_WAITING_STATUS, "memory status mismatch");
assert(startGateWaitingStatus(sample(20 * 1024, 65, 16), 4096, 4) === START_GATE_WAITING_LOAD_STATUS, "load status mismatch");
assert(startGateWaitingStatus(sample(300, 65, 16), 4096, 4) === START_GATE_WAITING_BOTH_STATUS, "combined status mismatch");
assert(startGateWaitingStatus(null, 4096, 4) === START_GATE_WAITING_PROBE_STATUS, "probe status mismatch");
const incident = sample(307, 146, 16);
assert(startGateReasons(incident, 4096, 4).length === 2, "10-06 incident must remain memory-and-load blocked");
assert(startGateWaitingStatus(incident, 4096, 4) === START_GATE_WAITING_BOTH_STATUS, "10-06 incident status mismatch");
for (const status of [START_GATE_WAITING_STATUS, START_GATE_WAITING_LOAD_STATUS, START_GATE_WAITING_BOTH_STATUS, START_GATE_WAITING_PROBE_STATUS]) {
  assert(isStartGateBlockedStatus(status), `restore does not recognize gate status: ${status}`);
}

console.log("POLICY_GREEN");
