import type { SourceReadChallenge, SourceLeaseRecheck } from "./session-source-evidence";
import type { SourceExecutionTask } from "./session-source-execution";
import type { SourceNodeDelivery } from "./session-source-delivery";
export const SOURCE_FORK_ROOT = "/api/node-session-control/source";
export const SOURCE_FORK_CAPABILITY = "source-fork-transport-v1-opencode-2.0.22";
export type SourceForkSelection = { network_id: string; source_node_id: string; session_id: string;
  mode: "fork_independent"; child_name: string; intent_id: string };
export type SourceForkTask = { request_id: string; intent_id: string; network_id: string; source_node_id: string;
  daemon_node_id: string } & (
  { phase: "evidence"; task: SourceReadChallenge } | { phase: "recheck"; task: SourceLeaseRecheck }
  | { phase: "execute"; task: SourceExecutionTask } | { phase: "deliver"; task: SourceNodeDelivery });
export type SourceForkStatus = "evidence_pending" | "evidence_claimed" | "recheck_pending" | "recheck_claimed"
  | "execute_pending" | "execute_claimed" | "deliver_pending" | "deliver_claimed"
  | "registration_confirmed" | "refused" | "unknown_rotation_required";
export type SourceForkReceipt = SourceForkSelection & { ok: true; request_id: string; daemon_node_id: string;
  status: SourceForkStatus; expires_at: number; child_node_id?: string; child_session_id?: string;
  native_acceptance: "not_verified"; dispatch_scope: "gated_preview" };
export const isSourceForkRequestId = (v: unknown): v is string => typeof v === "string" && /^srcf_[a-f0-9-]{36}$/.test(v);
