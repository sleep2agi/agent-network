/** Shared Codex node `flags.*` contract (create_node + update_node_config). */

export const REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ModelReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

export const CODEX_APPROVAL_POLICIES = [
  "untrusted",
  "on-failure",
  "on-request",
  "never",
] as const;

export const CODEX_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

/** Runtimes that may carry Codex posture / reasoning flags. */
export const CODEX_CONFIG_FLAG_RUNTIMES = new Set<string>(["codex-sdk", "codex-app-server"]);

export const CODEX_CONFIG_ONLY_FLAG_KEYS = new Set<string>([
  "approvalPolicy",
  "sandboxMode",
  "skipGitRepoCheck",
  "copresenceFullAccess",
  "modelReasoningEffort",
]);

export function isModelReasoningEffort(v: unknown): v is ModelReasoningEffort {
  return typeof v === "string" && (REASONING_EFFORT_VALUES as readonly string[]).includes(v);
}

export function validateCodexConfigFlag(
  key: string,
  val: unknown,
  runtime: string | null | undefined,
): { field: string; reason: string } | null {
  if (!CODEX_CONFIG_ONLY_FLAG_KEYS.has(key)) return null;
  if (runtime && !CODEX_CONFIG_FLAG_RUNTIMES.has(runtime)) {
    return { field: `flags.${key}`, reason: `only supported for codex-sdk / codex-app-server runtimes` };
  }
  if (key === "copresenceFullAccess" && runtime && runtime !== "codex-app-server") {
    return { field: "flags.copresenceFullAccess", reason: "only supported when node runtime is codex-app-server" };
  }
  switch (key) {
    case "approvalPolicy":
      if (typeof val !== "string" || !(CODEX_APPROVAL_POLICIES as readonly string[]).includes(val)) {
        return { field: "flags.approvalPolicy", reason: `must be one of ${CODEX_APPROVAL_POLICIES.join("/")}` };
      }
      return null;
    case "sandboxMode":
      if (typeof val !== "string" || !(CODEX_SANDBOX_MODES as readonly string[]).includes(val)) {
        return { field: "flags.sandboxMode", reason: `must be one of ${CODEX_SANDBOX_MODES.join("/")}` };
      }
      return null;
    case "skipGitRepoCheck":
    case "copresenceFullAccess":
      if (typeof val !== "boolean") return { field: `flags.${key}`, reason: "must be boolean" };
      return null;
    case "modelReasoningEffort":
      if (!isModelReasoningEffort(val)) {
        return { field: "flags.modelReasoningEffort", reason: `must be one of ${REASONING_EFFORT_VALUES.join("/")}` };
      }
      return null;
    default:
      return null;
  }
}
