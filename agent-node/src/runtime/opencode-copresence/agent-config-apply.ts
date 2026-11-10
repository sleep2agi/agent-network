// Agent (OpenCode "Build") selection for a live V2 session.
//
// Verified against a real server (not a fixture):
//   POST /api/session/<ses_>/agent {"agent":"general"}  -> 204
//   GET  /api/session/<ses_>                            -> agent == "general"
//
// Two things this deliberately does NOT do:
//   1. It never guesses a default agent. `null` is rejected as unsupported
//      because the server exposes no "clear agent" operation — writing a
//      guessed value would silently change how the user's session behaves.
//   2. It never falls back to a restart. A restart reopens the previous
//      agent, so "restart" would look like success while doing nothing.

export type V2AgentResult =
  | { status: "applied"; agent: string }
  | { status: "rejected"; reason: "unsupported" | "invalid" | "scope" | "busy" | "concurrent" }
  | { status: "unknown" };

export interface AgentSessionLike {
  readonly isRunning: boolean;
  readonly sessionId: string;
  selectedSessionAgent?(id: string): Promise<string | undefined>;
  selectSessionAgent?(id: string, agent: string): Promise<V2AgentResult>;
}

/** Dedicated no-restart path. Undefined session (no co-presence runtime) is
 *  reported as unsupported rather than degraded to a restart. */
export async function applyAgentConfig(
  session: AgentSessionLike | undefined,
  agent: string | null,
): Promise<V2AgentResult> {
  if (!session?.isRunning || !session.selectedSessionAgent || !session.selectSessionAgent)
    return { status: "rejected", reason: "unsupported" };
  if (agent === null) return { status: "rejected", reason: "unsupported" };
  if (typeof agent !== "string" || agent.length === 0 || agent.length > 200)
    return { status: "rejected", reason: "invalid" };
  let current: string | undefined;
  try {
    current = await session.selectedSessionAgent(session.sessionId);
  } catch {
    return { status: "rejected", reason: "scope" };
  }
  if (!session.isRunning) return { status: "rejected", reason: "scope" };
  if (current === agent) return { status: "applied", agent };
  try {
    return await session.selectSessionAgent(session.sessionId, agent);
  } catch {
    return { status: "unknown" };
  }
}
