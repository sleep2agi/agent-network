import { createHash } from "node:crypto";
import { inspectV1OwnedSafeTopology, type InspectV1OwnedSafeTopologyOptions } from "./v1-owned-safe-topology";

export class V1SafeRetentionRequestError extends Error {
  readonly code = "opencode_v1_safe_retention_request_refused";
  constructor() { super("OpenCode V1 retention request observation refused; no retention or migration performed"); }
}
const refuse = (): never => { throw new V1SafeRetentionRequestError(); };
export interface ObserveV1SafeRetentionRequestOptions extends InspectV1OwnedSafeTopologyOptions {
  /** Owner-selected correlation ID, not an authorization token or lease. */
  readonly requestId: string;
}
function binding(options: ObserveV1SafeRetentionRequestOptions) {
  const { observedAt: _observedAt, ...snapshot } = inspectV1OwnedSafeTopology(options);
  return Object.freeze(snapshot);
}
type Binding = ReturnType<typeof binding>;
export interface V1SafeRetentionRequestObservation {
  readonly schema: 1;
  readonly purpose: "owned-safe-v1-retention-request-observation";
  readonly state: "unprepared";
  readonly requestId: string;
  readonly requestSha256: string;
  readonly sourceBinding: Binding;
  readonly sourceLifecycle: "active-allocation-only";
  readonly retentionPrepared: false;
  readonly cleanupParticipating: false;
  readonly durable: false;
  readonly custodyProven: false;
  readonly credentialsCleanupProven: false;
  readonly handoffAllowed: false;
  readonly commitAllowed: false;
  readonly requiredBeforePreparation: readonly string[];
}
// An observation can only be rechecked by its issuing module instance. Even a
// byte-identical JSON reconstruction is not a durable recovery/custody entry.
const issued = new WeakMap<V1SafeRetentionRequestObservation, string>();
function digest(requestId: string, sourceBinding: Binding): string {
  return createHash("sha256").update(JSON.stringify({ schema: 1,
    purpose: "owned-safe-v1-retention-request-observation", requestId, sourceBinding })).digest("hex");
}
function validateId(options: ObserveV1SafeRetentionRequestOptions): void {
  if (typeof options.requestId !== "string" || options.requestId.length < 32 || options.requestId.length > 64
    || /[^a-f0-9]/.test(options.requestId)) refuse();
}

/** Read-only correlation and exact source recheck; does not prepare retention.
 * No marker write, cleanup exemption, native-process attestation or authority. */
export function observeV1SafeRetentionRequest(options: ObserveV1SafeRetentionRequestOptions): V1SafeRetentionRequestObservation {
  try {
    validateId(options);
    const sourceBinding = binding(options), requestSha256 = digest(options.requestId, sourceBinding);
    const observation: V1SafeRetentionRequestObservation = Object.freeze({ schema: 1,
      purpose: "owned-safe-v1-retention-request-observation", state: "unprepared",
      requestId: options.requestId, requestSha256, sourceBinding,
      sourceLifecycle: "active-allocation-only", retentionPrepared: false, cleanupParticipating: false,
      durable: false, custodyProven: false, credentialsCleanupProven: false, handoffAllowed: false, commitAllowed: false,
      requiredBeforePreparation: Object.freeze([
        "original Owner authority and exact participating runtime capability",
        "durable versioned source-owned marker with crash/unknown recovery",
        "credential persistence/cleanup qualification independent of data retention",
        "exit/after-exit and old/external stale-sweeper retention qualification",
        "independent every-writer exclusion, native process/model/version, target and backup gates",
      ]) });
    issued.set(observation, requestSha256);
    return observation;
  } catch { return refuse(); }
}

/** Still read-only: a successful recheck grants none of the pending gates.
 * Closing/replacing the original allocation or editing config/checkpoint
 * refuses; no attempt to adopt, replay, clear, or reconstruct the observation. */
export function revalidateV1SafeRetentionRequest(observation: V1SafeRetentionRequestObservation,
  options: ObserveV1SafeRetentionRequestOptions): V1SafeRetentionRequestObservation {
  try {
    validateId(options);
    const expected = issued.get(observation);
    if (!expected || expected !== observation.requestSha256 || observation.requestId !== options.requestId
      || digest(options.requestId, binding(options)) !== expected) refuse();
    return observation;
  } catch { return refuse(); }
}
