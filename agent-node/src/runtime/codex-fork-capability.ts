import { execFile } from "node:child_process";
import { minimalEnv } from "./create-node-daemon.js";

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
