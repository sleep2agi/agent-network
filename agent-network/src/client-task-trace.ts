import { sendTaskWithTrace } from "./task-trace";

export async function sendClientTaskWithTrace(input: {
  alias: string;
  fromAlias: string;
  parentTaskId?: string | null;
  networkId?: string | null;
}, dependencies: {
  send: () => Promise<any>;
  log: (line: string) => void;
}): Promise<any> {
  return sendTaskWithTrace({
    fromAlias: input.fromAlias,
    toAlias: input.alias,
    parentTaskId: input.parentTaskId || null,
    networkId: input.networkId || null,
    transport: "mcp_http",
    lifecycleTracking: "not_tracked",
  }, dependencies);
}
