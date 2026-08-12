import { CommHubError } from "./reply-reliability.js";

export interface PeerReplySendArgs {
  target: string;
  text: string;
  taskId: string;
  failed: boolean;
  fromAlias: string;
}

export interface PeerReplySendDeps {
  sendAtomic: (args: PeerReplySendArgs) => Promise<any>;
  sendLegacyReply: (args: PeerReplySendArgs) => Promise<any>;
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
 * legacy capability would risk a second write after an ambiguous response.
 */
export function isPeerReplyCapabilityUnavailable(error: unknown): boolean {
  if (!(error instanceof CommHubError)) return false;
  return error.code === "peer_reply_unsupported"
    || error.code === "peer_reply_origin_not_node"
    || error.code === "reply_task_not_owned"
    || error.code === "peer_reply_node_token_required"
    || isUnknownTool(error);
}

export async function sendPeerReplyCompatible(
  args: PeerReplySendArgs,
  deps: PeerReplySendDeps,
  cache: PeerReplyCapabilityCache = createPeerReplyCapabilityCache(),
): Promise<{ route: "atomic" | "legacy-reply"; payload: any }> {
  try {
    const payload = await deps.sendAtomic(args);
    cache.hubSupportsTool = true;
    return { route: "atomic", payload };
  } catch (error) {
    if (!isPeerReplyCapabilityUnavailable(error)) throw error;
    // Capability downgrade must preserve the original task's terminal state.
    // A legacy send_task creates a second response-requiring task, leaves the
    // original running, and can restart reply ping-pong. send_reply is the
    // established old-Hub primitive: it terminalizes the exact original and
    // stores one requires_response=none result for later inbox drain.
    // Negative capability observations are not cached, so a later Hub or
    // recipient upgrade can use the atomic route.
    return { route: "legacy-reply", payload: await deps.sendLegacyReply(args) };
  }
}
