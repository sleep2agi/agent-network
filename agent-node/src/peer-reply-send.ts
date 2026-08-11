import { CommHubError } from "./reply-reliability.js";

export interface PeerReplySendArgs {
  target: string;
  text: string;
  taskId: string;
  failed: boolean;
  fromAlias: string;
  fallbackReason?: "old_hub_unknown_tool" | "recipient_unsupported" | "identity_changed";
}

export interface PeerReplySendDeps {
  sendAtomic: (args: PeerReplySendArgs) => Promise<any>;
  sendLegacy: (args: PeerReplySendArgs) => Promise<any>;
}

export interface PeerReplyCapabilityCache {
  hubSupportsTool: true | null;
}

export function createPeerReplyCapabilityCache(): PeerReplyCapabilityCache {
  return { hubSupportsTool: null };
}

function isUnknownTool(error: unknown): boolean {
  if (!(error instanceof CommHubError)) return false;
  if (error.code === -32601) return true;
  const message = String(error.message || "");
  return error.code === -32602
    && /(?:unknown|not found|does not exist).{0,80}send_peer_reply|send_peer_reply.{0,80}(?:unknown|not found|does not exist)/i.test(message);
}

/**
 * Only explicit protocol/capability failures may fall back. Transport errors
 * stay errors so the pending-reply queue retries them; treating an outage as
 * "legacy Hub" would create a second task after an ambiguous write.
 */
export function isPeerReplyCapabilityUnavailable(error: unknown): boolean {
  if (!(error instanceof CommHubError)) return false;
  return error.code === "peer_reply_unsupported"
    || error.code === "reply_task_not_owned"
    || error.code === "peer_reply_node_token_required"
    || isUnknownTool(error);
}

export async function sendPeerReplyCompatible(
  args: PeerReplySendArgs,
  deps: PeerReplySendDeps,
  cache: PeerReplyCapabilityCache = createPeerReplyCapabilityCache(),
): Promise<{ route: "atomic" | "legacy"; payload: any }> {
  try {
    const payload = await deps.sendAtomic(args);
    cache.hubSupportsTool = true;
    return { route: "atomic", payload };
  } catch (error) {
    if (!isPeerReplyCapabilityUnavailable(error)) throw error;
    const fallbackReason = isUnknownTool(error)
      ? "old_hub_unknown_tool" as const
      : error instanceof CommHubError
        && (error.code === "reply_task_not_owned" || error.code === "peer_reply_node_token_required")
        ? "identity_changed" as const
        : "recipient_unsupported" as const;
    // Negative capability observations are deliberately not cached. A Hub
    // upgrade or recipient restart may make the next attempt capable.
    return { route: "legacy", payload: await deps.sendLegacy({ ...args, fallbackReason }) };
  }
}
