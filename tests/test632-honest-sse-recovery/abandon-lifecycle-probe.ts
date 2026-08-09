import { superviseChild } from "../../agent-node/src/util/supervise-child";

// Model the production SSE abandon path with deterministic time. The probe
// deliberately keeps one unrelated handle alive, as agent-node does (status
// timers, channel servers, runtime handles). If superviseChild only returns,
// this process stays alive; if it exits/kills the process, the parent harness
// cannot observe the marker and kill -0 check.
let now = 0;
await superviseChild({
  label: "test632-sse",
  shutdownGate: () => false,
  runOnce: async () => {},
  abandonAfterMs: 1,
  jitterRatio: 0,
  now: () => now,
  sleep: async (ms) => { now += ms; },
  onAbandon: () => process.stdout.write("ON_ABANDON\n"),
});

process.stdout.write(`ABANDON_RETURNED_PROCESS_ALIVE pid=${process.pid}\n`);
setInterval(() => {}, 60_000);
