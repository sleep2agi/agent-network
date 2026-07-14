// RFC-030 Wave 1B — gateway policy layer.
//
// Two enforcement surfaces, both DENY-BY-DEFAULT:
//
//   1. Upstream method allowlist (`evaluateUpstreamCall`). The gateway is
//      the only component that speaks Codex JSON-RPC; even so, the set of
//      methods it may emit is pinned to the tiny allowlist below. Anything
//      else — raw JSON-RPC passthrough, thread manipulation beyond the
//      bound thread, shellCommand, fs, config, auth, account, model, cwd,
//      sandbox or approval overrides — is refused with a typed reason.
//      This is defense-in-depth: the Agent-side typed contract (A's
//      contract.ts) can't even express those calls, but if a bug ever
//      hands the gateway a raw method string, the policy still stops it.
//
//   2. Phase-1 fixed profile (`assertPhase1Profile`). Wave-0 decision:
//      sandbox is read-only, approval policy is `never` surfaced to the
//      agent (the bridge never answers approvals; write access + approvals
//      stay DISABLED until a later wave). Any attempt to boot the gateway
//      with a different profile fails closed.
//
// Pure module: no I/O, fully unit-testable.

export interface PolicyDecisionAllowed {
  readonly allowed: true;
  readonly method: string;
}

export interface PolicyDecisionDenied {
  readonly allowed: false;
  readonly method: string;
  readonly reason: string;
  /** Stable machine code for logs / tests. */
  readonly code:
    | "method_not_allowlisted"
    | "thread_not_bound"
    | "config_override_attempt"
    | "approval_response_attempt";
}

export type PolicyDecision = PolicyDecisionAllowed | PolicyDecisionDenied;

/**
 * The ONLY upstream JSON-RPC methods the gateway may emit in Phase 1.
 * Everything else is denied — including any approval response (approvals
 * are answered exclusively by the human TUI, which has its own client).
 */
const UPSTREAM_ALLOWLIST: ReadonlySet<string> = new Set([
  "initialize",
  "initialized", // notification
  "thread/resume",
  "thread/start",
  "turn/start",
]);

/**
 * Deny patterns with human-readable rationale. Checked BEFORE the
 * allowlist so a method that somehow appears in both is still denied.
 * Substring/prefix matching is deliberate: codex renames like
 * `shellCommand/execute` vs `item/shellCommand/…` should all trip.
 */
const DENY_RULES: ReadonlyArray<{ test: (m: string) => boolean; code: PolicyDecisionDenied["code"]; reason: string }> = [
  {
    test: (m) => /approval|requestUserInput|serverRequest\/respond/i.test(m),
    code: "approval_response_attempt",
    reason: "approvals and user-input responses belong to the human TUI, never the gateway",
  },
  {
    // Config/identity/policy surface first: it wins ties like
    // `execpolicy/amend` (which is a policy override, not a shell call).
    test: (m) => /config|auth|account|login|logout|model\/|sandbox|cwd|policy/i.test(m),
    code: "config_override_attempt",
    reason: "config/auth/account/model/cwd/sandbox/policy overrides are locked",
  },
  {
    test: (m) => /shellCommand|exec|fs\/|file\/|writeFile|readFile|applyPatch/i.test(m),
    code: "method_not_allowlisted",
    reason: "shell/fs surface is disabled in Phase 1 (read-only sandbox)",
  },
];

/**
 * Evaluate an upstream call the gateway is about to emit.
 * `boundThreadId` is the single thread this gateway owns; any call
 * carrying a different threadId is refused (`thread_not_bound`).
 */
export function evaluateUpstreamCall(
  method: string,
  params: unknown,
  boundThreadId: string | null,
): PolicyDecision {
  for (const rule of DENY_RULES) {
    if (rule.test(method)) {
      return { allowed: false, method, reason: rule.reason, code: rule.code };
    }
  }
  if (!UPSTREAM_ALLOWLIST.has(method)) {
    return {
      allowed: false,
      method,
      reason: `method '${method}' is not in the Phase-1 upstream allowlist`,
      code: "method_not_allowlisted",
    };
  }
  // Bound-thread check: if the params carry a threadId it must equal the
  // bound thread. thread/start (fresh thread) is exempt — it's how the
  // binding is first established when no persisted thread exists.
  if (method !== "thread/start") {
    const p = params as { threadId?: unknown } | null | undefined;
    if (p && typeof p === "object" && "threadId" in p) {
      if (typeof p.threadId !== "string" || boundThreadId === null || p.threadId !== boundThreadId) {
        return {
          allowed: false,
          method,
          reason: `threadId '${String((p as { threadId?: unknown }).threadId)}' does not match the bound thread`,
          code: "thread_not_bound",
        };
      }
    }
  }
  return { allowed: true, method };
}

// ────────────────────────────────────────────────────────────────────────
// Phase-1 fixed profile
// ────────────────────────────────────────────────────────────────────────

export interface Phase1Profile {
  readonly sandboxMode: string;
  readonly approvalPolicy: string;
}

export const PHASE1_PROFILE: Phase1Profile = Object.freeze({
  sandboxMode: "read-only",
  approvalPolicy: "never",
});

/**
 * Fail-closed guard at gateway boot: Phase 1 runs read-only / never, no
 * exceptions, no env overrides. A later wave relaxes this deliberately.
 */
export function assertPhase1Profile(profile: Phase1Profile): void {
  if (profile.sandboxMode !== PHASE1_PROFILE.sandboxMode) {
    throw new Error(
      `gateway policy: Phase 1 requires sandbox_mode=read-only (got '${profile.sandboxMode}') — refusing to boot`,
    );
  }
  if (profile.approvalPolicy !== PHASE1_PROFILE.approvalPolicy) {
    throw new Error(
      `gateway policy: Phase 1 requires approval_policy=never (got '${profile.approvalPolicy}') — refusing to boot`,
    );
  }
}
