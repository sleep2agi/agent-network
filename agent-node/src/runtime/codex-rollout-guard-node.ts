// Board #734 — agent-node's own codex launches (codex-sdk, owned app-server):
// refuse to resume a paginated rollout with codex < 0.145. See codex-rollout-history-guard.ts.
import { codexSessionsRoot, findCodexRolloutFile } from "./codex-thread-size-check";
import { checkRolloutCodexCompat, type FirstLineRead } from "./codex-rollout-history-guard";

export interface NodeRolloutGuardInput {
  threadId: string;
  /** Env whose CODEX_HOME the spawned codex will use. */
  env: NodeJS.ProcessEnv;
  codexBin: string;
  /** Lazily resolved; only consulted when the rollout is paginated. */
  codexVersion: () => string | null | undefined;
  pointAtNewerCodex: string[];
  readFirstLine?: (path: string) => FirstLineRead;
}

export function nodeRolloutGuard(input: NodeRolloutGuardInput): { block: string[] | null; warnings: string[] } {
  const rolloutPath = findCodexRolloutFile(codexSessionsRoot(input.env), input.threadId);
  const v = checkRolloutCodexCompat({
    threadId: input.threadId,
    rolloutPath,
    codexBin: input.codexBin,
    get codexVersion() { return input.codexVersion(); },
    pointAtNewerCodex: input.pointAtNewerCodex,
    readFirstLine: input.readFirstLine,
  });
  if (v.verdict === "block") return { block: v.lines, warnings: [] };
  if (v.verdict === "unknown") return { block: null, warnings: v.lines };
  return { block: null, warnings: [] };
}

/** codex-sdk: the binary comes from config `codexBin` > env ANET_CODEX_BIN > PATH > bundled (#1969). */
export const SDK_POINT_AT_NEWER_CODEX = [
  `set "codexBin": "/path/to/codex" in this node's config.json, or ANET_CODEX_BIN=/path/to/codex (check first: /path/to/codex --version)`,
  `(without either, the codex bundled with agent-node is used, and it may be older than 0.145)`,
];

/** Owned app-server: spawns `codex` from PATH. */
export const OWNED_APPSERVER_POINT_AT_NEWER_CODEX = [
  `put codex >= 0.145 first on PATH for this node's process (e.g. npm i -g @openai/codex@latest), then restart the node`,
];
