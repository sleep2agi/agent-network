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

// ── #538 — the ANET_CODEX_STDIO_DIRECT=1 lane (direct `codex app-server` stdio)
//
// That lane built its own thread/start literal: `approvalPolicy: "on-request"`
// + `sandboxPolicy: { type: "dangerFullAccess" }`, ignoring the node's flags.
// Measured against real `codex app-server` 0.133.0 and 0.155.1 (fresh
// CODEX_HOME): `thread/start` takes the sandbox as `sandbox: <SandboxMode>`
// (kebab-case, see types/codex/v2/ThreadStartParams.ts) and silently ignores
// a `sandboxPolicy` key — the response came back `readOnly` both with and
// without it. So the "full access" literal was dead on the wire, and a node
// configured read-only / workspace-write / never had no way to reach codex at
// all: the thread ran with whatever ~/.codex/config.toml said.
//
// Now: configured `flags.sandboxMode` → `sandbox`, `flags.approvalPolicy` →
// `approvalPolicy`. Unconfigured nodes keep exactly the posture they had on
// the wire before (approvalPolicy "on-request", no sandbox override → codex's
// own config decides). We deliberately do NOT adopt the codex-sdk lane's
// danger-full-access default here: since the old literal never took effect,
// doing so would silently ESCALATE every unconfigured stdio node to full
// access. An invalid value is passed through and codex rejects it with
// -32600 (fail closed, visible), rather than being dropped.

export const CODEX_STDIO_DEFAULT_APPROVAL_POLICY = "on-request";

export interface CodexStdioThreadStartParams {
  model: string;
  approvalPolicy: string;
  sandbox?: string;
  threadId?: string;
}

export function buildCodexStdioThreadStartParams(
  flags: unknown,
  model: string,
  threadId?: string | null,
): CodexStdioThreadStartParams {
  const cfgFlags = (flags && typeof flags === "object" ? flags : {}) as Record<string, unknown>;
  const params: CodexStdioThreadStartParams = {
    model,
    approvalPolicy: typeof cfgFlags.approvalPolicy === "string" ? cfgFlags.approvalPolicy : CODEX_STDIO_DEFAULT_APPROVAL_POLICY,
  };
  if (typeof cfgFlags.sandboxMode === "string") params.sandbox = cfgFlags.sandboxMode;
  if (threadId) params.threadId = threadId;
  return params;
}
