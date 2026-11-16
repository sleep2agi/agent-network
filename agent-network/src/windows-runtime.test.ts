import { expect, test } from "bun:test";
import { windowsRuntimeSupported } from "./windows-runtime.js";
import { windowsRuntimeSupported as daemonSupports } from "../../agent-node/src/shared/windows-runtime.js";
import { windowsSdkBatchEvidence, windowsSdkEvidenceScript } from "./windows-sdk-stop-evidence.js";
import { orchestrateWindowsManagedStop, probeWindowsCreationDate } from "./windows-codex-copresence.js";

test("Windows CLI and daemon agree on SDK-only first-run support", () => {
  for (const runtime of ["claude-agent-sdk", "claude-code-cli", "codex-sdk", "codex-app-server", "grok-build-cli", "grok-build-acp", "opencode-cli"]) {
    expect(windowsRuntimeSupported(runtime, "win32")).toBe(runtime === "claude-agent-sdk");
    expect(daemonSupports(runtime, "win32")).toBe(windowsRuntimeSupported(runtime, "win32"));
    expect(windowsRuntimeSupported(runtime, "linux")).toBe(true);
    expect(windowsRuntimeSupported(runtime, "darwin")).toBe(true);
  }
});

const sdkRoot = { pid: 8100, role: "wrapper", creationDate: "999" };
const agentRoot = { pid: 8744, role: "agent", creationDate: "888" };
const wire = (value: unknown) => `SDKSTOP:${JSON.stringify(value)}`;
const captured = {
  checks: [{ pid: 8100, before: "999", after: "999" }, { pid: 8744, before: "888", after: "888" }],
  rows: [{ pid: 8100, ppid: 1, birth: "999", after: "999", stable: true }, { pid: 8744, ppid: 8100, birth: "888", after: "888", stable: true }],
};

for (const lateChild of [false, true]) test(`SDK batch stop uses one capture and one final query; unaccounted child=${lateChild}`, () => {
  let calls = 0;
  const evidence = windowsSdkBatchEvidence(script => {
    calls++;
    return script.includes("$checks=") ? wire(captured) : wire({
      rows: lateChild ? [{ pid: 9999, ppid: 8744 }] : [{ pid: 9000, ppid: 1 }],
      states: [{ pid: 8100, birth: "ABSENT" }, { pid: 8744, birth: "ABSENT" }],
    });
  });
  const kills: number[] = [];
  const stopped = orchestrateWindowsManagedStop([sdkRoot, agentRoot], {
    ...evidence,
    runPowerShell: script => script.includes("GetProcessById(8100)") ? "IDSTATE:TICKS=999" : "IDSTATE:TICKS=888",
    runTaskkill: pid => { kills.push(pid); return { status: 128, signal: null, stderrSummary: "", stderrDroppedBytes: 0 }; },
  });
  expect(calls).toBe(2);
  expect(kills).toEqual([8744, 8100]);
  expect(stopped.verdict.kind).toBe(lateChild ? "unverifiable" : "stopped");
});

test("SDK batch evidence retains unknown on changed births, unstable parents and malformed snapshots", () => {
  for (const changed of [
    { ...captured, checks: [{ pid: 8100, before: "999", after: "1000" }] },
    { ...captured, rows: [captured.rows[0], { ...captured.rows[1], stable: false }] },
    { ...captured, rows: [captured.rows[0], { ...captured.rows[1], after: "890" }] },
  ]) {
    const evidence = windowsSdkBatchEvidence(() => wire(changed));
    expect(evidence.captureRoots!([sdkRoot])[0].unknownReason).toBeDefined();
  }
  for (const bad of ["", "SDKSTOP:{}", wire({ rows: [] })]) {
    const evidence = windowsSdkBatchEvidence(() => bad);
    expect(() => evidence.captureRoots!([sdkRoot])).toThrow();
  }
  const evidence = windowsSdkBatchEvidence(() => wire({ rows: [{ pid: 9000, ppid: 1 }], states: [{ pid: 8100, birth: "ERROR" }] }));
  expect(evidence.readFinalEvidence!([sdkRoot]).probe(sdkRoot)).toBe("unknown");
  expect(() => windowsSdkEvidenceScript([{ ...sdkRoot, creationDate: "999';throw 'injected" }], true)).toThrow();
});

test("SDK batch stop never reports success for a live descendant or unavailable final evidence", () => {
  for (const unavailable of [false, true]) {
    const evidence = windowsSdkBatchEvidence(script => {
      if (script.includes("$checks=")) return wire(captured);
      if (unavailable) throw Error("snapshot unavailable");
      return wire({ rows: [{ pid: 8744, ppid: 8100 }], states: [{ pid: 8100, birth: "ABSENT" }, { pid: 8744, birth: "888" }] });
    });
    const result = orchestrateWindowsManagedStop([sdkRoot], {
      ...evidence,
      runPowerShell: () => "IDSTATE:TICKS=999",
      runTaskkill: () => ({ status: 0, signal: null, stderrSummary: "", stderrDroppedBytes: 0 }),
    });
    expect(result.verdict.kind).toBe(unavailable ? "unverifiable" : "survived");
    expect(result.mustKeepRecord).toBe(true);
  }
});

test.skipIf(process.platform !== "win32")("native SDK batch evidence uses Toolhelp and exact birth identity without CIM", () => {
  const birth = probeWindowsCreationDate(process.pid);
  expect(birth).not.toBeNull();
  const root = { pid: process.pid, role: "test", creationDate: birth! };
  const evidence = windowsSdkBatchEvidence();
  expect(evidence.captureRoots!([root])[0].unknownReason).toBeUndefined();
  expect(evidence.readFinalEvidence!([root]).probe(root)).toBe("alive");
  expect(windowsSdkEvidenceScript([root], true)).not.toContain("Get-CimInstance");
});
