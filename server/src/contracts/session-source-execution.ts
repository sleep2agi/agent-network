import { isSourceReadEvidence, type SourceReadEvidence } from "./session-source-evidence";
export type SourceExecutionTask = {
  execution_id: string; admission_request_id: string; evidence: SourceReadEvidence;
  authorized_until: number; owner_policy: "retain_existing_bridge_only";
};
export type SourceExecutionResult = {
  execution_id: string; admission_request_id: string;
  status: "session_ready" | "refused" | "unknown";
  session_id?: string; bridge: "not_created";
};
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
export function isSourceExecutionTask(v: unknown): v is SourceExecutionTask {
  return object(v) && Object.keys(v).length === 5 && typeof v.execution_id === "string" && /^srcx_[a-f0-9-]{36}$/.test(v.execution_id)
    && typeof v.admission_request_id === "string" && /^cr_[A-Za-z0-9_-]{1,190}$/.test(v.admission_request_id)
    && isSourceReadEvidence(v.evidence) && v.owner_policy === "retain_existing_bridge_only"
    && Number.isSafeInteger(v.authorized_until) && v.authorized_until > 0 && v.authorized_until <= v.evidence.request.expires_at;
}
export function isSourceExecutionResult(v: unknown, task: SourceExecutionTask): v is SourceExecutionResult {
  if (!object(v) || Object.keys(v).some(k => !["execution_id", "admission_request_id", "status", "session_id", "bridge"].includes(k))
    || v.execution_id !== task.execution_id || v.admission_request_id !== task.admission_request_id || v.bridge !== "not_created") return false;
  if (v.status === "unknown" || v.status === "refused") return v.session_id === undefined;
  return v.status === "session_ready" && typeof v.session_id === "string" && /^ses_[A-Za-z0-9]+$/.test(v.session_id)
    && (task.evidence.request.mode === "attach_existing" ? v.session_id === task.evidence.request.session_id : v.session_id !== task.evidence.request.session_id);
}
