// RFC-030 Wave 1B — TUI request authorizer (Phase-1 policy, 通信龙拍板).
//
// A's protocol layer classifies + id-rewrites human TUI requests and asks
// this hook for a verdict BEFORE anything is written upstream. Frozen
// Phase-1 rules:
//
//   reservation = human | none:
//     - turn/start, turn/steer → ALLOW (human owns their conversation)
//   reservation = agent:
//     - turn/start, turn/steer → DENY (stable busy code, never sent
//       upstream — the human sees "agent task running" instead of a raw
//       server -32010)
//     - turn/interrupt         → ALLOW as emergency; the gateway then
//       moves the interrupted agent task to `interrupted_by_human`
//       (structured terminal state, NO auto-replay)
//   always:
//     - config/auth/account/model/sandbox/execpolicy mutations → DENY
//     - operations addressing a thread other than the bound one → DENY
//     - approval responses NEVER pass through this authorizer: they are
//       consumed exclusively via the pending reverse-id map (A's layer);
//       unknown/duplicate response ids fail closed there.
//
// Human-steering-an-agent-turn is Phase 2; nothing here may enable it.

import type { ReservationOwner } from "./scheduler";

export type TuiRequestDecision =
  | { readonly verdict: "allow" }
  | { readonly verdict: "deny"; readonly reason: string; readonly code: string };

export interface TuiRequestAuthorizer {
  authorize(req: { method: string; params: unknown }): TuiRequestDecision;
}

export const TUI_DENY_CODES = {
  busyAgent: "tui_thread_busy_agent",
  configLocked: "tui_config_locked",
  threadNotBound: "tui_thread_not_bound",
} as const;

const CONFIG_MUTATION = /config|auth|account|login|logout|model\/|sandbox|execpolicy|policy\//i;
const TURN_START_OR_STEER = new Set(["turn/start", "turn/steer"]);
const TURN_INTERRUPT = "turn/interrupt";

export function createTuiAuthorizer(opts: {
  boundThreadId: () => string | null;
  reservation: () => ReservationOwner;
}): TuiRequestAuthorizer {
  return {
    authorize(req: { method: string; params: unknown }): TuiRequestDecision {
      const { method, params } = req;

      // Locked shared-server state mutations — always deny for TUI too.
      if (CONFIG_MUTATION.test(method)) {
        return {
          verdict: "deny",
          reason: "config/auth/account/model/sandbox/policy mutations are locked in Phase 1",
          code: TUI_DENY_CODES.configLocked,
        };
      }

      // Bound-thread check on any request that names a thread.
      const bound = opts.boundThreadId();
      const p = params as { threadId?: unknown } | null | undefined;
      if (p && typeof p === "object" && "threadId" in p) {
        if (typeof p.threadId !== "string" || bound === null || p.threadId !== bound) {
          return {
            verdict: "deny",
            reason: "request addresses a thread this gateway is not bound to",
            code: TUI_DENY_CODES.threadNotBound,
          };
        }
      }

      // Interrupt is the human's emergency brake — allowed regardless of
      // who holds the reservation.
      if (method === TURN_INTERRUPT) return { verdict: "allow" };

      if (TURN_START_OR_STEER.has(method)) {
        if (opts.reservation() === "agent") {
          return {
            verdict: "deny",
            reason:
              "an Agent Network task holds the thread; wait for it to finish or use turn/interrupt",
            code: TUI_DENY_CODES.busyAgent,
          };
        }
        return { verdict: "allow" };
      }

      // Everything else conversational (reads, searches, status…) — allow.
      return { verdict: "allow" };
    },
  };
}
