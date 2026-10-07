// Board #734 — pre-start guard for the codex co-presence launchers (POSIX + Windows).
// Runs before the previous generation is quiesced, so a refusal leaves whatever is
// running untouched. See codex-rollout-history-guard.ts for the why.
import { findThreadRollouts } from "./codex-pending-thread-restart";
import {
  checkRolloutCodexCompat,
  probeCodexVersionCached,
  type FirstLineRead,
} from "./codex-rollout-history-guard";

export interface CopresenceRolloutGuardInput {
  codexHome: string;
  /** Threads this start may resume (recorded thread, pending candidate). Empty entries are skipped. */
  threadIds: Array<string | undefined | null>;
  codexBin: string;
  displayName: string;
  probeVersion?: (bin: string) => string | null;
  findRollouts?: (codexHome: string, threadId: string) => string[] | null;
  readFirstLine?: (path: string) => FirstLineRead;
}

export interface CopresenceRolloutGuardResult {
  /** Non-null = refuse to start; print these lines. */
  block: string[] | null;
  /** Could-not-tell notes; print and continue. */
  warnings: string[];
}

export function copresenceRolloutGuard(input: CopresenceRolloutGuardInput): CopresenceRolloutGuardResult {
  const warnings: string[] = [];
  const ids = [...new Set(input.threadIds.filter((t): t is string => typeof t === "string" && t.length > 0))];
  if (ids.length === 0) return { block: null, warnings };
  const find = input.findRollouts ?? findThreadRollouts;
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
    const matches = find(input.codexHome, threadId);
    const paths: Array<string | null> = matches && matches.length > 0 ? matches : [null];
    for (const rolloutPath of paths) {
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
  }
  return { block: null, warnings };
}
