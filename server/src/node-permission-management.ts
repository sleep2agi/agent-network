import { grantLevelForTarget } from "./node-grants.js";
import { type NodeIdentity } from "./node-permissions.js";

/** Node-only delegation. User authorization stays on its existing path. */
export function permissionManagementDenial(
  caller: NodeIdentity | null, networkId: string, targetNodeId: string,
): "self" | "not_granted" | null {
  if (caller?.nodeId === targetNodeId) return "self";
  if (!caller?.nodeId || caller.networkId !== networkId) return "not_granted";
  return grantLevelForTarget(networkId, caller.nodeId, "permissions", targetNodeId, caller.mode) === "edit"
    ? null : "not_granted";
}

export function permissionManagementAudit(caller: NodeIdentity | null): Record<string, string> {
  return caller?.nodeId
    ? { actor_node_id: caller.nodeId, via: "permissions_grant", message: `由 ${caller.aliases[0] || caller.nodeId} 节点（授权）修改` }
    : {};
}
