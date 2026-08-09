const REASON_DETAILS: Record<string, string> = {
  self: "sender alias equals node alias; reply-loop guard",
  "own-prefix": "message carries this node's own reply prefix; reply-loop guard",
  cooldown: "sender cooldown is active",
  "low-value-inbound": "non-task message matched the low-value filter",
};

export function formatInboxSkipLog(input: {
  sender: string;
  reason: string;
  taskId: string;
  messageType: string;
}): string {
  const detail = REASON_DETAILS[input.reason] || "inbound filter rejected the message";
  return `skipped inbound ${input.messageType} ${input.taskId} from ${input.sender}: ${input.reason} (${detail}); acknowledged without model delivery`;
}
