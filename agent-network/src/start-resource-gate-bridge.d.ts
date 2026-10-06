/** Types for the runtime re-export in start-resource-gate-bridge.js. The implementation stays in agent-node. */
export function waitForStartResources(
  label: string,
  deps?: {
    nodeId?: string;
    log?: (msg: string) => void;
    warn?: (msg: string) => void;
    report?: (text: string) => void;
  },
): Promise<{ release: () => void }>;
