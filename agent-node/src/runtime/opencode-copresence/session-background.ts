// #2014: semantic Ctrl+B for ONE existing V2 session. No terminal input,
// prompt replay, restart, abort, credential projection or shared-server action.
import { randomUUID } from "node:crypto";

export type SessionBackgroundErrorCode =
  | "session_control_unavailable" | "session_control_changed"
  | "session_control_unsupported" | "session_control_invalid_response"
  | "session_control_request_invalid" | "session_control_request_expired" | "session_control_request_limit"
  | "session_background_outcome_unknown";
export class SessionBackgroundError extends Error {
  constructor(readonly code: SessionBackgroundErrorCode) { super(code); }
}
export interface SessionBackgroundState {
  session_id: string;
  binding_id: string;
  supported: boolean;
  active: boolean;
  /** Ability to REQUEST, not evidence that a particular tool is backgroundable. */
  can_request_background: boolean;
  observed_at: number;
}
export interface SessionBackgroundIntent {
  session_id: string;
  binding_id: string;
  request_id: string;
  expires_at: number;
}
export interface SessionBackgroundReceipt {
  /** Upstream 204 means processed, NOT proof a tool moved to the background. */
  outcome: "request_processed" | "already_idle";
  state: SessionBackgroundState;
}
export interface SessionBackgroundControl {
  state(): Promise<SessionBackgroundState>;
  background(intent: SessionBackgroundIntent, permit?: SessionControlPermit): Promise<SessionBackgroundReceipt>;
}
/** Process-local authority only. Never accepted from or serialized onto the wire. */
export interface SessionControlPermit {
  checkpoint(): void;
  readonly signal: AbortSignal;
}
type Request = (path: string, init?: RequestInit) => Promise<any>;
const fail = (code: SessionBackgroundErrorCode): never => { throw new SessionBackgroundError(code); };
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

export function createSessionBackgroundControl(opts: {
  sessionId: string;
  directory: string;
  isCurrent: () => boolean;
  request: Request;
  now?: () => number;
}): SessionBackgroundControl {
  if (!/^ses_[A-Za-z0-9]+$/.test(opts.sessionId)) fail("session_control_changed");
  const bindingId = randomUUID(); // local handle generation, never disk identity
  const now = opts.now ?? Date.now;
  const receipts = new Map<string, { createdAt: number; result: Promise<SessionBackgroundReceipt> }>();
  let inFlight = false;
  const current = () => { if (!opts.isCurrent()) fail("session_control_changed"); };
  async function read(path: string, permit?: SessionControlPermit) {
    current();
    permit?.checkpoint();
    try {
      const value = await opts.request(path, { redirect: "error", ...(permit ? { signal: permit.signal } : {}) });
      current();
      permit?.checkpoint();
      return value;
    } catch (e) {
      if (e instanceof SessionBackgroundError) throw e;
      fail("session_control_unavailable");
    }
  }
  async function state(permit?: SessionControlPermit): Promise<SessionBackgroundState> {
    // Never use a bare busy heartbeat or the presence of V2 as API capability.
    const schema = await read("/openapi.json", permit);
    const supported = schema?.paths?.["/api/session/{sessionID}/background"]?.post?.operationId === "session.background";
    const session = await read(`/api/session/${opts.sessionId}`, permit);
    if (session?.data?.id !== opts.sessionId || session?.data?.location?.directory !== opts.directory) fail("session_control_changed");
    const active = await read("/api/session/active", permit);
    if (!object(active?.data) || Object.values(active.data).some(v => !object(v) || v.type !== "running")) fail("session_control_invalid_response");
    const running = Object.hasOwn(active.data, opts.sessionId);
    return { session_id: opts.sessionId, binding_id: bindingId, supported, active: running,
      can_request_background: supported && running, observed_at: now() };
  }
  const fresh = (intent: SessionBackgroundIntent) => {
    const time = now();
    if (!Number.isFinite(intent.expires_at) || intent.expires_at <= time || intent.expires_at > time + 30_000) fail("session_control_request_expired");
  };
  async function perform(intent: SessionBackgroundIntent, permit?: SessionControlPermit): Promise<SessionBackgroundReceipt> {
    const before = await state(permit);
    fresh(intent); // Reads can exhaust the Hub deadline; never write afterwards.
    permit?.checkpoint();
    if (!before.supported) fail("session_control_unsupported");
    if (!before.active) return { outcome: "already_idle", state: before };
    current();
    permit?.checkpoint(); // No await between authority check and the only write.
    // ONE write, never retry. A timeout can occur after OpenCode applied it.
    try { await opts.request(`/api/session/${opts.sessionId}/background`, { method: "POST", redirect: "error", ...(permit ? { signal: permit.signal } : {}) }); }
    catch { return fail("session_background_outcome_unknown"); }
    try {
      const after = await state(permit);
      permit?.checkpoint();
      return { outcome: "request_processed", state: after };
    }
    catch { return fail("session_background_outcome_unknown"); }
  }
  return {
    state,
    background(intent, permit) {
      current();
      if (intent.session_id !== opts.sessionId || intent.binding_id !== bindingId) fail("session_control_changed");
      const key = typeof intent.request_id === "string" && /^bg_([0-9]{13})_[A-Za-z0-9_-]{8,64}$/.exec(intent.request_id);
      if (!key) return fail("session_control_request_invalid");
      const createdAt = Number(key[1]), time = now();
      // Hub-issued timestamped intent IDs let us discard old receipts without
      // reopening old writes. A repeated expired ID can never become fresh.
      if (createdAt < time - 120_000 || createdAt > time + 10_000) fail("session_control_request_expired");
      for (const [id, receipt] of receipts) if (receipt.createdAt < time - 120_000) receipts.delete(id);
      const prior = receipts.get(intent.request_id);
      if (prior) return prior.result; // includes errors/unknown ACK: no replay
      permit?.checkpoint();
      fresh(intent);
      // Bound memory without evicting a mutation receipt and reopening replay.
      if (receipts.size >= 128 || inFlight) fail("session_control_request_limit");
      inFlight = true;
      const result = perform(intent, permit).finally(() => { inFlight = false; });
      receipts.set(intent.request_id, { createdAt, result });
      return result;
    },
  };
}
