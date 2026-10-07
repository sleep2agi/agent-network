// Board #734 — pre-start guard for the codex co-presence launchers (POSIX + Windows)
// and external app-server nodes. Runs before the previous generation is quiesced, so a
// refusal leaves whatever is running untouched. See codex-rollout-history-guard.ts.
import { spawnSync } from "child_process";
import {
  checkRolloutCodexCompat,
  probeCodexVersionCached,
  resolveCodexResumeRollout,
  type FirstLineRead,
} from "./codex-rollout-history-guard";

export interface CopresenceRolloutGuardInput {
  codexHome: string;
  /** Threads this start may resume (recorded thread, pending candidate). Empty entries are skipped. */
  threadIds: Array<string | undefined | null>;
  /** The binary the launch will run — resolve it first (resolveLaunchCodexBin) so probe = launch. */
  codexBin: string;
  displayName: string;
  probeVersion?: (bin: string) => string | null;
  resolveRollout?: (codexHome: string, threadId: string) => string | null;
  readFirstLine?: (path: string) => FirstLineRead;
}

export interface CopresenceRolloutGuardResult {
  /** Non-null = refuse to start; print these lines. */
  block: string[] | null;
  /** Could-not-tell notes; print and continue. */
  warnings: string[];
}

/**
 * The POSIX launchers run codex inside `bash -lc "exec <codexBin> …"`, so a bare
 * name is looked up on the LOGIN shell's PATH, which can differ from anet's own
 * PATH (profile scripts, nvm, …). Resolve it once, the same way, and hand the
 * absolute path to both the version probe and the launch so they cannot diverge.
 * Paths (containing "/") are returned unchanged; on failure the name is returned
 * unchanged (the launch then behaves exactly as before).
 */
export function resolveLaunchCodexBin(
  codexBin: string,
  opts: { loginShell: boolean; env?: NodeJS.ProcessEnv; run?: typeof spawnSync },
): { bin: string; resolvedFrom?: string } {
  if (process.platform === "win32" || codexBin.includes("/")) return { bin: codexBin };
  const run = opts.run ?? spawnSync;
  const env = opts.env ?? process.env;
  try {
    const r = run("bash", [opts.loginShell ? "-lc" : "-c", 'command -v -- "$1"', "anet-resolve-codex", codexBin], {
      encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], env,
    });
    const out = String(r.stdout ?? "").trim().split("\n").pop() ?? "";
    if (!r.error && r.status === 0 && out.startsWith("/")) return { bin: out, resolvedFrom: codexBin };
  } catch { /* fall through */ }
  return { bin: codexBin };
}

export function copresenceRolloutGuard(input: CopresenceRolloutGuardInput): CopresenceRolloutGuardResult {
  const warnings: string[] = [];
  const ids = [...new Set(input.threadIds.filter((t): t is string => typeof t === "string" && t.length > 0))];
  if (ids.length === 0) return { block: null, warnings };
  const resolve = input.resolveRollout ?? resolveCodexResumeRollout;
  let version: string | null | undefined;
  const getVersion = () => {
    if (version === undefined) version = (input.probeVersion ?? probeCodexVersionCached)(input.codexBin);
    return version;
  };
  const node = /^[A-Za-z0-9._-]+$/.test(input.displayName) ? input.displayName : `'${input.displayName.replace(/'/g, `'\\''`)}'`;
  const pointAt = [
    `anet node start ${node} --codex-bin /path/to/codex   (check first: /path/to/codex --version)`,
    `or put codex >= 0.145 first on PATH for whatever starts this node (e.g. npm i -g @openai/codex@latest)`,
  ];
  for (const threadId of ids) {
    const rolloutPath = resolve(input.codexHome, threadId);
    const v = checkRolloutCodexCompat({
      threadId,
      rolloutPath,
      codexBin: input.codexBin,
      // Only spawn `--version` when there is a rollout to compare against.
      get codexVersion() { return rolloutPath ? getVersion() : null; },
      pointAtNewerCodex: pointAt,
      readFirstLine: input.readFirstLine,
    });
    if (v.verdict === "block") return { block: v.lines, warnings };
    if (v.verdict === "unknown") warnings.push(...v.lines);
  }
  return { block: null, warnings };
}
