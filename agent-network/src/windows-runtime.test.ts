import { expect, test } from "bun:test";
import { windowsRuntimeSupported } from "./windows-runtime.js";
import { windowsRuntimeSupported as daemonSupports } from "../../agent-node/src/shared/windows-runtime.js";
import { windowsSdkBatchEvidence, windowsSdkEvidenceScript, openWindowsSdkEvidenceSession, sdkEvidenceReason, windowsSdkHelperLaunch } from "./windows-sdk-stop-evidence.js";
import { orchestrateWindowsManagedStop, orchestrateWindowsManagedStopAsync, probeWindowsCreationDate } from "./windows-codex-copresence.js";

test("Windows CLI and daemon agree: SDK by default, ACP only with ANET_ALLOW_ACP_WINDOWS=1", () => {
  const off = {} as NodeJS.ProcessEnv;
  const on = { ANET_ALLOW_ACP_WINDOWS: "1" } as NodeJS.ProcessEnv;
  const runtimes = ["claude-agent-sdk", "claude-code-cli", "codex-sdk", "codex-app-server", "grok-build-cli", "grok-build-acp", "opencode-cli", "antigravity-acp"];
  for (const runtime of runtimes) {
    // 默认口径不变：win32 只有 SDK；ACP stdio 要显式开
    expect(windowsRuntimeSupported(runtime, "win32", off)).toBe(runtime === "claude-agent-sdk");
    expect(windowsRuntimeSupported(runtime, "win32", on)).toBe(runtime === "claude-agent-sdk" || runtime === "antigravity-acp");
    // 开关只放 ACP stdio 这一条，TUI/co-presence 仍然挡住
    if (runtime !== "antigravity-acp") expect(windowsRuntimeSupported(runtime, "win32", on)).toBe(runtime === "claude-agent-sdk");
    // CLI 与 daemon 两份实现必须逐条一致（独立 npm 包，靠这条断言防漂移）
    for (const env of [off, on]) expect(daemonSupports(runtime, "win32", env)).toBe(windowsRuntimeSupported(runtime, "win32", env));
    expect(windowsRuntimeSupported(runtime, "linux", off)).toBe(true);
    expect(windowsRuntimeSupported(runtime, "darwin", off)).toBe(true);
  }
});

test("ANET_ALLOW_ACP_WINDOWS 只认字面 1（不把 \"true\"/空串当开）", () => {
  for (const value of ["", "0", "true", "yes", " 1"]) {
    expect(windowsRuntimeSupported("antigravity-acp", "win32", { ANET_ALLOW_ACP_WINDOWS: value } as NodeJS.ProcessEnv)).toBe(false);
  }
});

const sdkRoot = { pid: 8100, role: "wrapper", creationDate: "999" };
const agentRoot = { pid: 8744, role: "agent", creationDate: "888" };
const wire = (value: unknown) => `SDKSTOP:${JSON.stringify(value)}`;
test("helper fixes module discovery to PSHOME before any cmdlet and stays noninteractive", () => {
  const launch = windowsSdkHelperLaunch();
  expect(launch.args).toContain("-NoProfile");
  expect(launch.args).toContain("-NonInteractive");
  const script = Buffer.from(launch.args[launch.args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
  expect(script.split("\n")[0]).toBe("$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')");
  expect(script.indexOf("$env:PSModulePath=")).toBeLessThan(script.indexOf("Add-Type"));
  expect(script).not.toContain("Join-Path");
  expect(script).not.toContain("$env:USERPROFILE");
  expect(windowsSdkEvidenceScript([sdkRoot], true).split("\n")[0]).toContain("$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')");
});
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

test.skipIf(process.platform !== "win32")("native SDK batch evidence uses Toolhelp and exact birth identity without CIM", async () => {
  const at = Date.now();
  const birth = probeWindowsCreationDate(process.pid);
  console.log(`[SDK probe] initial_birth_ms=${Date.now() - at}`);
  expect(birth).not.toBeNull();
  const root = { pid: process.pid, role: "test", creationDate: birth! };
  const session = await openWindowsSdkEvidenceSession({ onProgress: message => console.log(`[SDK probe] ${message}`) });
  try {
    expect((await session.deps.captureRoots!([root]))[0].unknownReason).toBeUndefined();
    expect((await session.deps.readFinalEvidence!([root])).probe(root)).toBe("alive");
    expect(await session.deps.probeRoot!(root)).toBe("alive");
    expect(windowsSdkEvidenceScript([root], true)).not.toContain("Get-CimInstance");
  } finally { session.close(); }
}, 60_000);

test("async evidence transport uses the same fail-closed stop decision flow", async () => {
  for (const fails of [false, true]) {
    const events: string[] = [];
    const sync = windowsSdkBatchEvidence(script => script.includes("$checks=") ? wire(captured) : wire({
      rows: [{ pid: 9000, ppid: 1 }], states: [{ pid: 8100, birth: "ABSENT" }, { pid: 8744, birth: "ABSENT" }],
    }));
    const result = await orchestrateWindowsManagedStopAsync([sdkRoot], {
      captureRoots: async roots => { events.push("capture"); if (fails) throw Error("capture timeout"); return sync.captureRoots!(roots); },
      probeRoot: async () => { events.push("prekill"); return "alive"; },
      runTaskkill: () => { events.push("kill"); return { status: 0, signal: null, stderrSummary: "", stderrDroppedBytes: 0 }; },
      readFinalEvidence: async ids => { events.push("final"); return sync.readFinalEvidence!(ids); },
    });
    expect(events).toEqual(["capture", "prekill", "kill", "final"]);
    expect(result.verdict.kind).toBe(fails ? "unverifiable" : "stopped");
    expect(result.mustKeepRecord).toBe(fails);
  }
});

// Real private child/pipe exercise in Docker, without needing Windows or tmux.
const fixture = (mode: string) => ({ command: process.execPath, args: ["-e", `
  const mode=${JSON.stringify(mode)};
  if(mode==='stderr-timeout') { process.stderr.write('Add-Type C:/private/secret-path ntok_private-secret'); console.log('SDKBOOT'); }
  else if(mode!=='startup-timeout') setTimeout(()=>{console.log('SDKBOOT');console.log('SDKCOMPILED');console.log('SDKREADY')},mode==='slow-start'?350:30);
  let buffer='';process.stdin.on('data',chunk=>{
    buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))>=0){
      const req=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
      if(mode==='query-timeout') continue;
      if(mode==='exit') process.exit(2);
      console.log(JSON.stringify({id:mode==='wrong-id'?req.id+1:req.id,ok:true,result:'IDSTATE:TICKS=999'}));
    }
  });
`] });

test("resident evidence helper reuses one session, excludes startup from query budget and closes", async () => {
  const logs: string[] = [];
  const session = await openWindowsSdkEvidenceSession({ launch: fixture("slow-start"), queryTimeoutMs: 200, onProgress: message => logs.push(message) });
  try {
    expect(await session.deps.probeRoot!(sdkRoot)).toBe("alive");
    expect(await session.deps.probeRoot!(sdkRoot)).toBe("alive");
    expect(logs.filter(line => line.includes("startup_compile_ms"))).toHaveLength(1);
    expect(logs.filter(line => line.includes("query_ms"))).toHaveLength(2);
  } finally { session.close(); }
  expect(await session.deps.probeRoot!(sdkRoot)).toBe("unknown");
});

test("resident evidence startup/query timeout, exit and wrong response identity fail closed", async () => {
  await expect(openWindowsSdkEvidenceSession({ launch: fixture("startup-timeout"), startupTimeoutMs: 200 })).rejects.toThrow("startup timeout");
  for (const mode of ["query-timeout", "exit", "wrong-id"]) {
    const session = await openWindowsSdkEvidenceSession({ launch: fixture(mode), queryTimeoutMs: 100 });
    try {
      expect(await session.deps.probeRoot!(sdkRoot)).toBe("unknown");
      await expect(session.deps.captureRoots!([sdkRoot])).rejects.toThrow();
    } finally { session.close(); }
  }
});

test("helper diagnostics retain stage/exit/output metadata but never upstream text or paths", async () => {
  let message = "";
  try { await openWindowsSdkEvidenceSession({ launch: fixture("stderr-timeout"), startupTimeoutMs: 500 }); }
  catch (error: any) { message = error.message; }
  expect(message).toContain("stage=script_entered");
  expect(message).toContain("exit_observed=false");
  expect(message).toContain("exit_code=none");
  expect(message).toContain("stderr_reason=compile_failed");
  expect(message).toContain("stdout_bytes=");
  expect(message).not.toContain("secret-path");
  expect(message).not.toContain("ntok_");
  expect(sdkEvidenceReason("C:/private/other-path")).toBe("unknown");
});
