import { execFile } from "node:child_process";
import { loadAndVerifyAnetBin, minimalEnv } from "./create-node-daemon.js";

// Probe the same pinned executable used for launch, without a shell or a
// version-number guess. This checks CLI syntax only, not Codex availability.
export function supportsCodexForkRecovery(bin: string, cwd: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile(bin, ["node", "start", "--help"], {
      cwd, env: minimalEnv(), timeout: 5_000, maxBuffer: 64 * 1024,
      encoding: "utf8", windowsHide: true,
    }, (error, stdout) => {
      resolve(!error && ["--fork-on-resume-failure", "--fork-recovery-request-id", "--yes"]
        .every(flag => new RegExp(`(?:^|\\s)${flag}(?=[\\s),]|$)`).test(stdout)));
    });
  });
}

export type CodexForkCapability = { protocol: 1; cli_supported: boolean };

/** Background syntax probe only. Heartbeats read cached evidence and never
 * await the subprocess. Execution still rechecks the pin and CLI capability. */
export function createCodexForkCapabilityMonitor(options: {
  bin?: () => string;
  cwd: string;
  onChange?: () => void;
  probe?: typeof supportsCodexForkRecovery;
}) {
  let capability: CodexForkCapability | undefined;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  function refresh(): Promise<void> {
    if (running) return running;
    running = (async () => {
      let supported = false;
      try { supported = await (options.probe ?? supportsCodexForkRecovery)((options.bin ?? loadAndVerifyAnetBin)(), options.cwd); }
      catch { /* missing/unsafe pin or failed probe: report false, no raw paths */ }
      const changed = capability?.cli_supported !== supported;
      capability = { protocol: 1, cli_supported: supported };
      if (changed) options.onChange?.();
    })().finally(() => { running = undefined; });
    return running;
  }
  return {
    current: () => capability,
    refresh,
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => { void refresh(); }, 10 * 60_000);
      timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
  };
}
