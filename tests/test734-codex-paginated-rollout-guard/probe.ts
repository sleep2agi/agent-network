// test734 probes — call the SHIPPED modules with REAL codex binaries.
// Usage: bun probe.ts <cmd> ...   Prints one `T734 {json}` line.
import { readFileSync } from "node:fs";
import { copresenceRolloutGuard } from "../../agent-network/src/codex-copresence-rollout-guard";
import { readRolloutFirstLine, checkRolloutCodexCompat } from "../../agent-node/src/runtime/codex-rollout-history-guard";
import { openCodexAppServerRuntime } from "../../agent-node/src/runtime/codex-app-server/runtime";

const [cmd, ...args] = process.argv.slice(2);
const out = (o: unknown) => console.log(`T734 ${JSON.stringify(o)}`);
const rchar = () => Number(/rchar:\s*(\d+)/.exec(readFileSync("/proc/self/io", "utf8"))?.[1] ?? NaN);

if (cmd === "guard") {
  // guard <codexHome> <threadId> <codexBin>  — real `--version` probe of the real binary
  const [codexHome, threadId, codexBin] = args;
  const r = copresenceRolloutGuard({ codexHome, threadIds: [threadId], codexBin, displayName: "t734n" });
  out({ blocked: r.block !== null, block: r.block, warnings: r.warnings });
} else if (cmd === "firstline") {
  // firstline <path>  — bytes the process actually read (kernel rchar) + wall time
  const [path] = args;
  const r0 = rchar();
  const t0 = performance.now();
  const r = readRolloutFirstLine(path);
  const v = checkRolloutCodexCompat({ threadId: "t", rolloutPath: path, codexBin: "c", codexVersion: "0.133.0", pointAtNewerCodex: [] });
  const ms = performance.now() - t0;
  out({ ok: r.line !== null, reportedBytes: r.bytesRead, kernelReadBytes: rchar() - r0, ms: Math.round(ms), verdict: v.verdict });
} else if (cmd === "owned") {
  // owned <codexHome> <threadId> <codexBin>  — agent-node's owned app-server path, real binary
  const [codexHome, threadId, binary] = args;
  const lines: string[] = [];
  let error = "";
  try {
    const s = await openCodexAppServerRuntime({
      threadId, codexHome, binary,
      log: (m) => lines.push(m), warn: (m) => lines.push(m),
    });
    try { s.client.close?.(); } catch { /* ignore */ }
    try { s.proc?.kill("SIGKILL"); } catch { /* ignore */ }
  } catch (e) {
    error = String((e as Error)?.message ?? e);
  }
  out({ error, spawned: lines.some((l) => l.includes("spawning")), lines });
  process.exit(0);
} else {
  console.error(`unknown cmd ${cmd}`);
  process.exit(2);
}
