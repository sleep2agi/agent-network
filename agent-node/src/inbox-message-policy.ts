export type InboxDeliveryPolicy = {
  deliverToRuntime: boolean;
  replyExpected: boolean;
};

/**
 * Task/broadcast rows are ordinary request-response work. A Hub `send_reply`
 * row is different: it is the terminal result of work this node dispatched.
 * The result must enter the runtime immediately, but must never generate a
 * reply to the reply (that would recreate the peer ping-pong loop).
 */
export function inboxDeliveryPolicy(type: string | null | undefined): InboxDeliveryPolicy {
  const normalized = type || "task";
  if (normalized === "task" || normalized === "broadcast") {
    return { deliverToRuntime: true, replyExpected: true };
  }
  if (normalized === "reply") {
    return { deliverToRuntime: true, replyExpected: false };
  }
  return { deliverToRuntime: false, replyExpected: false };
}
