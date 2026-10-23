// #2014 node-owned REST consumer. Independent of the model turn's work lane.
// SSE is only a doorbell; immutable identity is supplied by the bound ntok.
import { SessionBackgroundError, type SessionBackgroundControl, type SessionControlPermit } from "./opencode-copresence/session-background";

type Session = { readonly isRunning: boolean; readonly sessionId: string; readonly backgroundControl?: SessionBackgroundControl };
type Binding = { session: Session; session_id: string; binding_id: string };
const ROOT = "/api/node-session-control";
const errors = new Set([
  "session_control_unavailable", "session_control_changed", "session_control_unsupported", "session_control_invalid_response",
  "session_control_request_invalid", "session_control_request_expired", "session_control_request_limit", "session_background_outcome_unknown",
]);
export interface SessionControlPin {
  readonly expected: Readonly<{ node_id: string; network_id: string }>;
  readonly signal: AbortSignal;
  checkpoint(): void;
  invalidate(): void;
  post(path: string, body: unknown): Promise<any>;
}

/** Snapshot the initial process identity. Hot rotation may disable, never rebind. */
export function createSessionControlPin(opts: {
  hubUrl: string; token: string; nodeId: string; networkId: string; epoch: number;
  currentToken: () => string; currentEpoch: () => number; signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): SessionControlPin {
  const { token, nodeId, networkId, epoch } = opts;
  const hub = opts.hubUrl.replace(/\/+$/, "");
  const expected = Object.freeze({ node_id: nodeId, network_id: networkId });
  const cancelled = new AbortController();
  const invalidate = () => { cancelled.abort(); };
  if (opts.signal.aborted) invalidate();
  else opts.signal.addEventListener("abort", invalidate, { once: true });
  const checkpoint = () => {
    if (cancelled.signal.aborted || !token.startsWith("ntok_") || !nodeId || !networkId
      || opts.currentToken() !== token || opts.currentEpoch() !== epoch) {
      invalidate(); throw new SessionBackgroundError("session_control_changed");
    }
  };
  return {
    expected, signal: cancelled.signal, checkpoint, invalidate,
    async post(path, body) {
      checkpoint();
      if (!/^\/api\/node-session-control\/(?:bridge|pull|(?:bg|sc)_[0-9]{13}_[A-Za-z0-9_-]{8,64}\/ack)$/.test(path)) {
        throw new SessionBackgroundError("session_control_request_invalid");
      }
      const response = await (opts.fetch ?? globalThis.fetch)(`${hub}${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body), redirect: "error",
        signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(5_000)]),
      });
      checkpoint();
      if (!response.ok) throw new SessionBackgroundError("session_control_unavailable");
      const value = await response.json();
      checkpoint(); return value;
    },
  };
}
export function createNodeSessionControlBridge(deps: {
  session: () => Session | null | undefined;
  identity: SessionControlPin;
  warn: (message: string) => void;
}) {
  let binding: Binding | null = null;
  let registered: Binding | null = null;
  let tokenId: string | null = null;
  let drain: Promise<void> | null = null;
  const current = (b: Binding) => {
    try { deps.identity.checkpoint(); return deps.session() === b.session && b.session.isRunning; }
    catch { return false; }
  };
  async function localBinding(): Promise<Binding | null> {
    deps.identity.checkpoint();
    const session = deps.session();
    if (!session?.isRunning || !session.backgroundControl) { binding = null; return null; }
    if (binding?.session === session) return binding;
    const state = await session.backgroundControl.state();
    deps.identity.checkpoint();
    if (deps.session() !== session || !session.isRunning || state.session_id !== session.sessionId) return null;
    return binding = { session, session_id: state.session_id, binding_id: state.binding_id };
  }
  const wire = (b: Binding) => ({ session_id: b.session_id, binding_id: b.binding_id });
  async function register() {
    try {
      const b = await localBinding();
      if (!b || !current(b)) return false;
      const reply = await deps.identity.post(`${ROOT}/bridge`, { ...wire(b), expected: deps.identity.expected });
      if (!current(b)) return false;
      const identity = reply?.identity;
      if (reply?.ok !== true || identity?.node_id !== deps.identity.expected.node_id
        || identity?.network_id !== deps.identity.expected.network_id
        || typeof identity?.token_id !== "string" || !identity.token_id || identity.token_id.length > 200
        || identity.token_id.trim() !== identity.token_id
        || (tokenId !== null && tokenId !== identity.token_id)) {
        registered = null; deps.identity.invalidate(); return false;
      }
      tokenId = identity.token_id;
      registered = b; return true;
    } catch { deps.warn("[session-control] registration unavailable; no session action taken"); return false; }
  }
  async function process() {
    for (let n = 0; n < 8; n++) {
      if (!registered) return;
      const b = await localBinding();
      if (!b || registered !== b || !current(b)) return;
      const permit: SessionControlPermit = { signal: deps.identity.signal, checkpoint() {
        deps.identity.checkpoint();
        if (registered !== b || !current(b)) throw new SessionBackgroundError("session_control_changed");
      } };
      const pulled = await deps.identity.post(`${ROOT}/pull`, wire(b));
      permit.checkpoint();
      if (!pulled?.ok || !pulled.request) return;
      const request = pulled.request;
      if (typeof request.request_id !== "string" || !/^(?:bg|sc)_[0-9]{13}_[A-Za-z0-9_-]{8,64}$/.test(request.request_id)) return;
      let ack: { status: "done" | "failed"; result?: unknown; error?: string };
      try {
        if (!current(b) || request.session_id !== b.session_id || request.binding_id !== b.binding_id) throw new SessionBackgroundError("session_control_changed");
        if (!Number.isFinite(request.expires_at) || request.expires_at < Date.now()) throw new SessionBackgroundError("session_control_request_expired");
        let result: unknown;
        if (request.operation === "state") result = await b.session.backgroundControl!.state();
        else if (request.operation === "background") result = await b.session.backgroundControl!.background({ ...wire(b), request_id: request.request_id, expires_at: request.expires_at }, permit);
        else throw new SessionBackgroundError("session_control_request_invalid");
        permit.checkpoint();
        ack = { status: "done", result };
      } catch (e) {
        ack = { status: "failed", error: e instanceof SessionBackgroundError && errors.has(e.code) ? e.code : "session_control_unavailable" };
      }
      // An ACK failure never re-enters the operation. Hub must report unknown,
      // not turn it back into a pending mutation on a reconnect.
      permit.checkpoint();
      await deps.identity.post(`${ROOT}/${encodeURIComponent(request.request_id)}/ack`, { ...wire(b), ...ack });
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
