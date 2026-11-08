import { isSourceExecutionTask, type SourceExecutionTask } from "./session-source-execution";
export const SOURCE_DELIVERY_CAPABILITY = "source-node-delivery-v1-opencode-2.0.22";
export type SourceNodeDelivery = {
  delivery_id: string; execution: SourceExecutionTask; session_id: string;
  child_node_id: string; child_name: string; child_token: string; expires_at: number;
};
export function isSourceNodeDelivery(v: any): v is SourceNodeDelivery {
  return !!v && typeof v === "object" && Object.keys(v).length === 7
    && typeof v.delivery_id === "string" && /^srcd_[a-f0-9-]{36}$/.test(v.delivery_id)
    && isSourceExecutionTask(v.execution) && typeof v.session_id === "string" && /^ses_[A-Za-z0-9]+$/.test(v.session_id)
    && typeof v.child_node_id === "string" && v.child_node_id === `node_${v.delivery_id}`
    && typeof v.child_name === "string" && v.child_name.length > 0 && v.child_name.length <= 256
    && typeof v.child_token === "string" && /^ntok_[A-Za-z0-9_-]+$/.test(v.child_token)
    && Number.isSafeInteger(v.expires_at) && v.expires_at > 0
    && (v.execution.evidence.request.mode === "attach_existing" ? v.session_id === v.execution.evidence.request.session_id : v.session_id !== v.execution.evidence.request.session_id);
}
