// Transport evidence only. Never turn an MCP notification write into a CLI
// admission/turn-start claim. This helper receives no message body or prompt.
export const CHANNEL_DELIVERY_CAPABILITY = "channel_notification_injected";

export function supportsChannelDeliveryEvidence(page: unknown): boolean {
  return (page as any)?.delivery_evidence?.[CHANNEL_DELIVERY_CAPABILITY] === 1;
}

export async function notifyAndAckChannelDelivery(options: {
  messageId: string;
  task: boolean;
  evidenceSupported: boolean;
  notify: () => Promise<void>;
  ack: (args: { message_id: string; channel_notification_injected?: true }) => Promise<any>;
}): Promise<{ notificationWritten: true; evidenceRecorded: boolean }> {
  try { await options.notify(); }
  catch { throw new Error("channel_notification_write_failed"); }
  let result: any;
  try {
    result = await options.ack({
      message_id: options.messageId,
      ...(options.task && options.evidenceSupported ? { channel_notification_injected: true as const } : {}),
    });
  } catch { throw new Error("channel_ack_failed"); }
  if (!result?.ok) throw new Error("channel_ack_rejected");
  return { notificationWritten: true, evidenceRecorded: result.channel_notification_injected === true };
}
