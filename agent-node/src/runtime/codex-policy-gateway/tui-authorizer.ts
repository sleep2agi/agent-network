// RFC-030 Wave 1B L3 — TUI request authorizer, implementing A's frozen
// `TuiRequestAuthorizer` surface (protocol.ts @ freeze 90d1e58).
//
// A's layer classifies TUI-inbound frames; `policy_delegate` frames land
// here BEFORE anything is written upstream. Phase-1 frozen rules
// (通信龙拍板 + 副指挥 default-deny P0):
//
//   allowlist (the ONLY forwardable methods):
//     initialize / initialized       — native TUI handshake (A answers
//                                      bootstrap itself; listed for the
//                                      policy_delegate defensive path)
//     thread/resume                  — re-attach, bound-thread-checked
//     turn/start, turn/steer         — reservation-gated (human owns
//                                      their conversation; agent holds →
//                                      stable Busy, never sent upstream)
//     turn/interrupt                 — ALWAYS allowed (emergency brake);
//                                      gateway then moves the interrupted
//                                      agent task to interrupted_by_human,
//                                      structured terminal, NO auto-replay
//   everything else                  — DENY (default-deny: shellCommand/*,
//                                      fs/*, applyPatch, serverRequest/
//                                      respond, thread/start, unknown)
//
//   approval responses NEVER pass through this authorizer: they are
//   consumed exclusively via A's ReverseRequestNamespace pending map;
//   unknown/duplicate response ids fail closed there.
//
// Deny codes are A's frozen GatewayErrorCode; the finer-grained Phase-1
// policy label travels in `extra.policy` so operators keep the old
// granularity without widening the frozen enum.
//
// Human-steering-an-agent-turn is Phase 2; nothing here may enable it.

import type { ReservationOwner } from "./scheduler";
import { GatewayErrorCode } from "./contract";
import type {
  JsonRpcRequestFrame,
  TuiPolicyDecision,
  TuiRequestAuthorizer,
} from "./protocol";

export type { TuiPolicyDecision, TuiRequestAuthorizer } from "./protocol";

/** Phase-1 fine-grained policy labels, surfaced via deny `extra.policy`. */
export const TUI_POLICY_LABELS = {
  busyAgent: "tui_thread_busy_agent",
  configLocked: "tui_config_locked",
  threadNotBound: "tui_thread_not_bound",
  methodNotAllowed: "tui_method_not_allowed",
} as const;

const CONFIG_MUTATION = /config|auth|account|login|logout|model\/|sandbox|execpolicy|policy\//i;
const TURN_START_OR_STEER = new Set(["turn/start", "turn/steer"]);
const TURN_INTERRUPT = "turn/interrupt";

/**
 * Phase-1 TUI allowlist — extending this list is a policy change that
 * requires review, not a code path that silently widens. NOT here on
 * purpose: thread/start (would create an UNBOUND thread), shellCommand/*,
 * fs/*, applyPatch/* (side-effectful), serverRequest/respond (approvals
 * go through the reverse-id pending map only).
 */
const TUI_METHOD_ALLOWLIST = new Set([
  "initialize",
  "initialized",
  "thread/resume",
  TURN_INTERRUPT,
  ...TURN_START_OR_STEER,
]);

function deny(
  code: GatewayErrorCode,
  policy: string,
  reason: string,
): TuiPolicyDecision {
  return { verdict: "deny", code, reason, extra: { policy } };
}

export function createTuiAuthorizer(opts: {
  boundThreadId: () => string | null;
  reservation: () => ReservationOwner;
}): TuiRequestAuthorizer {
  return {
    async authorize(frame: JsonRpcRequestFrame): Promise<TuiPolicyDecision> {
      const { method, params } = frame;

      // Locked shared-server state mutations — checked FIRST so the
      // operator sees the sharper label even though the allowlist would
      // also catch these.
      if (CONFIG_MUTATION.test(method)) {
        return deny(
          GatewayErrorCode.UnknownMethod,
          TUI_POLICY_LABELS.configLocked,
          "config/auth/account/model/sandbox/policy mutations are locked in Phase 1",
        );
      }

      // Default-deny: anything off the explicit Phase-1 allowlist never
      // reaches the upstream socket (0-forward), regardless of shape.
      if (!TUI_METHOD_ALLOWLIST.has(method)) {
        return deny(
          GatewayErrorCode.UnknownMethod,
          TUI_POLICY_LABELS.methodNotAllowed,
          `method '${method}' is not on the Phase-1 TUI allowlist`,
        );
      }

      // Bound-thread check on any request that names a thread.
      const bound = opts.boundThreadId();
      const p = params as { threadId?: unknown } | null | undefined;
      if (p && typeof p === "object" && "threadId" in p) {
        if (typeof p.threadId !== "string" || bound === null || p.threadId !== bound) {
          return deny(
            GatewayErrorCode.InvalidArg,
            TUI_POLICY_LABELS.threadNotBound,
            "request addresses a thread this gateway is not bound to",
          );
        }
      }

      // Interrupt is the human's emergency brake — allowed regardless of
      // who holds the reservation.
      if (method === TURN_INTERRUPT) return { verdict: "allow" };

      if (TURN_START_OR_STEER.has(method)) {
        if (opts.reservation() === "agent") {
          return deny(
            GatewayErrorCode.Busy,
            TUI_POLICY_LABELS.busyAgent,
            "an Agent Network task holds the thread; wait for it to finish or use turn/interrupt",
          );
        }
        return { verdict: "allow" };
      }

      // Remaining allowlisted handshake methods (initialize/initialized/
      // thread-checked thread/resume) — allow.
      return { verdict: "allow" };
    },
  };
}
