// #534 — the ONE place the codex-sdk runtime turns a node's config `flags`
// block into Codex SDK thread options.
//
// Before this module there were three hand-copied option literals in cli.ts:
// the first-turn start/resume path read `fileConfig.flags`, the goal-wake path
// mirrored it, and the "codex thread error, 重建" retry path hard-coded
// `sandboxMode: "danger-full-access"` + `approvalPolicy: "never"`. A node the
// operator configured read-only / workspace-write therefore ran its *retry*
// turn with full access and no approvals — silently, on exactly the path that
// only runs after something already went wrong.
//
// Every startThread / resumeThread call in the codex-sdk runtime must build
// its options here. Defaults are unchanged from the pre-#534 primary path:
// unconfigured nodes still get skipGitRepoCheck=true, approvalPolicy=never,
// sandboxMode=danger-full-access, modelReasoningEffort=low.

export const CODEX_SDK_DEFAULT_APPROVAL_POLICY = "never";
export const CODEX_SDK_DEFAULT_SANDBOX_MODE = "danger-full-access";

export interface CodexSdkThreadOptions {
  skipGitRepoCheck: boolean;
  approvalPolicy: any;
  model: string;
  sandboxMode: any;
  modelReasoningEffort: "low";
}

export function buildCodexSdkThreadOptions(flags: unknown, model: string): CodexSdkThreadOptions {
  const cfgFlags = (flags && typeof flags === "object" ? flags : {}) as Record<string, unknown>;
  return {
    skipGitRepoCheck: cfgFlags.skipGitRepoCheck === false ? false : true,
    approvalPolicy: typeof cfgFlags.approvalPolicy === "string" ? cfgFlags.approvalPolicy : CODEX_SDK_DEFAULT_APPROVAL_POLICY,
    model,
    sandboxMode: typeof cfgFlags.sandboxMode === "string" ? cfgFlags.sandboxMode : CODEX_SDK_DEFAULT_SANDBOX_MODE,
    modelReasoningEffort: "low" as const,
  };
}

/** Minimal shape of the Codex SDK client the rebuild path needs. */
export interface CodexSdkThreadStarter<T> {
  startThread(opts: CodexSdkThreadOptions): T;
}

/**
 * The retry/rebuild step after a failed turn: a fresh thread built from the
 * node's configured flags — never a hard-coded permission posture.
 */
export function rebuildCodexSdkThread<T>(codex: CodexSdkThreadStarter<T>, flags: unknown, model: string): T {
  return codex.startThread(buildCodexSdkThreadOptions(flags, model));
}
