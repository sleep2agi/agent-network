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
  sendLegacyReply: (args: PeerReplySendArgs) => Promise<any>;
  /**
   * An old Hub lacks send_peer_reply but still exposes get_task. Read the
   * exact original task and classify its immutable from_node_id:
   * node origin -> send_task wake path; non-node origin -> send_reply
   * terminalization. Throw when the task identity is unavailable or
   * malformed so an ambiguous reply stays pending instead of guessing from
   * an alias roster that may be stale or contain a same-name user.
   */
  isOldHubOriginNode: (args: PeerReplySendArgs) => Promise<boolean>;
}

export interface PeerReplyCapabilityCache {
  hubSupportsTool: true | null;
}

export function createPeerReplyCapabilityCache(): PeerReplyCapabilityCache {
  return { hubSupportsTool: null };
}

function oldHubIdentityUnavailable(cause?: unknown): CommHubError {
  return new CommHubError(
    "old Hub task identity unavailable; preserving pending reply",
    {
      code: "old_hub_task_identity_unavailable",
      ...(cause instanceof CommHubError ? { payload: cause.payload } : {}),
    },
  );
}

/**
 * Resolve the immutable origin kind from the exact old-Hub task row. Every
 * failure is deliberately reclassified as retryable: get_task's app-level
 * task-not-found must not reach PendingReplyQueue's drop-loud branch.
 *
 * A historical NULL from_node_id is conservatively treated as "no proven
 * node identity" and therefore uses terminal send_reply. Guessing from a
 * current alias roster could wake an unrelated replacement node.
 */
export async function resolveOldHubTaskOrigin(
  args: PeerReplySendArgs,
  loadTask: (taskId: string) => Promise<any>,
): Promise<boolean> {
  let result: any;
  try {
    result = await loadTask(args.taskId);
  } catch (error) {
    throw oldHubIdentityUnavailable(error);
  }
  const task = result?.task;
  if (!result?.ok || !task || task.task_id !== args.taskId
      || (task.from_node_id !== null && typeof task.from_node_id !== "string")) {
    throw oldHubIdentityUnavailable();
  }
  return typeof task.from_node_id === "string" && task.from_node_id.length > 0;
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
    || error.code === "peer_reply_origin_not_node"
    || error.code === "reply_task_not_owned"
    || error.code === "peer_reply_node_token_required"
    || isUnknownTool(error);
}

export async function sendPeerReplyCompatible(
  args: PeerReplySendArgs,
  deps: PeerReplySendDeps,
  cache: PeerReplyCapabilityCache = createPeerReplyCapabilityCache(),
): Promise<{ route: "atomic" | "legacy" | "legacy-reply"; payload: any }> {
  try {
    const payload = await deps.sendAtomic(args);
    cache.hubSupportsTool = true;
    return { route: "atomic", payload };
  } catch (error) {
    if (!isPeerReplyCapabilityUnavailable(error)) throw error;
    if (error instanceof CommHubError && error.code === "peer_reply_origin_not_node") {
      return { route: "legacy-reply", payload: await deps.sendLegacyReply(args) };
    }
    const oldHub = isUnknownTool(error);
    if (oldHub && !(await deps.isOldHubOriginNode(args))) {
      return { route: "legacy-reply", payload: await deps.sendLegacyReply(args) };
    }
    const fallbackReason = oldHub
      ? "old_hub_unknown_tool" as const
      : error instanceof CommHubError
        && (error.code === "reply_task_not_owned" || error.code === "peer_reply_node_token_required")
        ? "identity_changed" as const
        : "recipient_unsupported" as const;
    // Negative capability observations are deliberately not cached. A Hub
    // upgrade or recipient restart may make the next attempt capable.
    try {
      return { route: "legacy", payload: await deps.sendLegacy({ ...args, fallbackReason }) };
    } catch (legacyError) {
      // A routine Dashboard node deletion removes the original sender's
      // session after dispatch. In that exact shape the compatibility
      // send_task has an authoritative no-write result (alias_not_found),
      // while send_reply can still terminalize the immutable original task.
      // Fall back only for that structured rejection. Ambiguous transport
      // failures and every other application error stay thrown so the
      // pending-reply queue retains them instead of risking a second write.
      if (legacyError instanceof CommHubError
          && legacyError.appLevel
          && legacyError.code === "alias_not_found") {
        return { route: "legacy-reply", payload: await deps.sendLegacyReply(args) };
      }
      throw legacyError;
    }
  }
}
