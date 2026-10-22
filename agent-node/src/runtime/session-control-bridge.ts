// #2014 node-owned REST consumer. Independent of the model turn's work lane.
// SSE is only a doorbell; immutable identity is supplied by the bound ntok.
import { SessionBackgroundError, type SessionBackgroundControl } from "./opencode-copresence/session-background";

type Session = { readonly isRunning: boolean; readonly sessionId: string; readonly backgroundControl?: SessionBackgroundControl };
type Binding = { session: Session; session_id: string; binding_id: string };
const ROOT = "/api/node-session-control";
const errors = new Set([
  "session_control_unavailable", "session_control_changed", "session_control_unsupported", "session_control_invalid_response",
  "session_control_request_invalid", "session_control_request_expired", "session_control_request_limit", "session_background_outcome_unknown",
]);
export function createNodeSessionControlBridge(deps: {
  session: () => Session | null | undefined;
  post: (path: string, body: unknown) => Promise<any>;
  warn: (message: string) => void;
}) {
  let binding: Binding | null = null;
  let drain: Promise<void> | null = null;
  const current = (b: Binding) => deps.session() === b.session && b.session.isRunning;
  async function localBinding(): Promise<Binding | null> {
    const session = deps.session();
    if (!session?.isRunning || !session.backgroundControl) { binding = null; return null; }
    if (binding?.session === session) return binding;
    const state = await session.backgroundControl.state();
    if (deps.session() !== session || !session.isRunning || state.session_id !== session.sessionId) return null;
    return binding = { session, session_id: state.session_id, binding_id: state.binding_id };
  }
  const wire = (b: Binding) => ({ session_id: b.session_id, binding_id: b.binding_id });
  async function register() {
    try {
      const b = await localBinding();
      if (b && current(b)) return (await deps.post(`${ROOT}/bridge`, wire(b)))?.ok === true;
      return false;
    } catch { deps.warn("[session-control] registration unavailable; no session action taken"); return false; }
  }
  async function process() {
    for (let n = 0; n < 8; n++) {
      const b = await localBinding();
      if (!b || !current(b)) return;
      const pulled = await deps.post(`${ROOT}/pull`, wire(b));
      if (!pulled?.ok || !pulled.request) return;
      const request = pulled.request;
      if (typeof request.request_id !== "string" || !/^(?:bg|sc)_[0-9]{13}_[A-Za-z0-9_-]{8,64}$/.test(request.request_id)) return;
      let ack: { status: "done" | "failed"; result?: unknown; error?: string };
      try {
        if (!current(b) || request.session_id !== b.session_id || request.binding_id !== b.binding_id) throw new SessionBackgroundError("session_control_changed");
        if (!Number.isFinite(request.expires_at) || request.expires_at < Date.now()) throw new SessionBackgroundError("session_control_request_expired");
        let result: unknown;
        if (request.operation === "state") result = await b.session.backgroundControl!.state();
        else if (request.operation === "background") result = await b.session.backgroundControl!.background({ ...wire(b), request_id: request.request_id, expires_at: request.expires_at });
        else throw new SessionBackgroundError("session_control_request_invalid");
        ack = { status: "done", result };
      } catch (e) {
        ack = { status: "failed", error: e instanceof SessionBackgroundError && errors.has(e.code) ? e.code : "session_control_unavailable" };
      }
      // An ACK failure never re-enters the operation. Hub must report unknown,
      // not turn it back into a pending mutation on a reconnect.
      await deps.post(`${ROOT}/${encodeURIComponent(request.request_id)}/ack`, { ...wire(b), ...ack });
    }
  }
  function trigger(): Promise<void> {
    if (drain) return drain;
    drain = process().catch(() => { deps.warn("[session-control] transport unavailable; operation was not replayed"); })
      .finally(() => { drain = null; });
    return drain;
  }
  return { register, trigger };
}
