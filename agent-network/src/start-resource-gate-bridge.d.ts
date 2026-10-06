/** Types for the runtime re-export in start-resource-gate-bridge.js. The implementation is the byte copy start-resource-gate.ts in this package. */
export function waitForStartResources(
  label: string,
  deps?: {
    nodeId?: string;
    log?: (msg: string) => void;
    warn?: (msg: string) => void;
    report?: (text: string) => void;
  },
): Promise<{ release: () => void }>;
