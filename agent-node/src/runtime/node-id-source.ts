export interface ResolveNodeIdInput {
  configNodeId?: string | null;
  envNodeId?: string | null;
  configPath?: string | null;
  warn?: (message: string) => void;
}

export interface ResolvedNodeId {
  value: string;
  source: "config" | "env" | "none";
}

function quoted(value: string): string {
  // JSON quoting keeps control characters from becoming terminal control
  // sequences while preserving the exact identity value for diagnosis.
  return JSON.stringify(value);
}

/**
 * Resolve the node identity used by a direct agent-node launch.
 *
 * A persisted config is the durable identity source. COMMHUB_NODE_ID is an
 * internal launcher-to-child propagation variable, not a documented identity
 * override. It remains a fallback for legacy direct launches whose config has
 * no node_id, but it must not replace a configured identity when inherited
 * from a stale supervisor shell.
 */
export function resolveNodeIdSource(input: ResolveNodeIdInput): ResolvedNodeId {
  const configNodeId = input.configNodeId || "";
  const envNodeId = input.envNodeId || "";

  if (configNodeId) {
    if (envNodeId && envNodeId !== configNodeId) {
      input.warn?.(
        `COMMHUB_NODE_ID mismatch: env=${quoted(envNodeId)} ` +
          `config=${quoted(configNodeId)} config_path=${quoted(input.configPath || "config.json")}; ` +
          `ignoring env COMMHUB_NODE_ID, using config node_id`,
      );
    }
    return { value: configNodeId, source: "config" };
  }

  if (envNodeId) return { value: envNodeId, source: "env" };
  return { value: "", source: "none" };
}
