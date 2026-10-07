// Board #734 — pre-start guard for the codex co-presence launchers (POSIX + Windows)
// and external app-server nodes. Runs before the previous generation is quiesced, so a
// refusal leaves whatever is running untouched. See codex-rollout-history-guard.ts.
import { spawnSync } from "child_process";
import {
  checkRolloutCodexCompat,
  parseCodexVersionOutput,
  probeCodexVersionCached,
  resolveCodexResumeRollout,
  type FirstLineRead,
} from "./codex-rollout-history-guard";

export interface CopresenceRolloutGuardInput {
  codexHome: string;
  /** Threads this start may resume (recorded thread, pending candidate). Empty entries are skipped. */
  threadIds: Array<string | undefined | null>;
  /** The binary as the launch names it (probeVersion should run it the way the launch does). */
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
 * `codex --version` run through the SAME shell preamble the launch uses, so the
 * probe sees the binary the launch will run: the launch command itself is never
 * rewritten. The co-presence panes run `bash -lc "… exec <codexBin> app-server"`
 * (login-shell PATH); external app-server panes run `bash -c "<source .env>; …;
 * <codexBin> app-server"` (the workspace .env may set PATH). `script` must end in
 * `exec <codexBin> --version`. Only a codex-identifying line counts; anything
 * else (or any failure) is null = unknown, which never blocks.
 */
export function probeCodexVersionViaShell(
  script: string,
  opts: { loginShell: boolean; env?: NodeJS.ProcessEnv; run?: typeof spawnSync },
): string | null {
  if (process.platform === "win32") return null;
  const key = `${opts.loginShell ? "l" : "c"}\0${script}`;
  if (!opts.run && shellProbeCache.has(key)) return shellProbeCache.get(key) ?? null;
  let version: string | null = null;
  try {
    const r = (opts.run ?? spawnSync)("bash", [opts.loginShell ? "-lc" : "-c", script], {
      encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], env: opts.env ?? process.env,
    });
    if (!r.error && r.status === 0) version = parseCodexVersionOutput(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  } catch { version = null; }
  if (!opts.run) shellProbeCache.set(key, version);
  return version;
}
const shellProbeCache = new Map<string, string | null>();

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
