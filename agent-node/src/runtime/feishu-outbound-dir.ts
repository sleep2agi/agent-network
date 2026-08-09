/**
 * Resolve the per-conversation outbound directory received from the Feishu
 * worker. New workers send the canonical directory verbatim. Legacy workers
 * omit it, so the parent reconstructs it from the same explicit connection
 * name it passed to that worker — never from ambient ANET_NODE_ALIAS state.
 */
export function resolveFeishuOutboundDir(
  workerOutboundDir: unknown,
  connectionName: string,
  conversationId: string,
): string {
  if (typeof workerOutboundDir === "string" && workerOutboundDir.length > 0) {
    return workerOutboundDir;
  }
  const connection = connectionName || "feishu";
  const conversation = (conversationId !== "?" ? conversationId : "default")
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  return `/work/feishu-attachments/${connection}/${conversation}/`;
}

export interface FeishuWorkerBinding {
  dir: string;
  connectionName: string;
}

/** Keep the worker's connectionName and the parent's legacy fallback bound. */
export function buildFeishuWorkerArgs(
  workerPath: string,
  binding: FeishuWorkerBinding,
): string[] {
  return [
    workerPath,
    "--channel-dir",
    binding.dir,
    "--node-alias",
    binding.connectionName,
  ];
}
