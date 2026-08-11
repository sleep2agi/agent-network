import { sendTaskWithTrace } from "./task-trace";

export async function sendPeerReplyTaskWithTrace(input: {
  alias: string;
  task: string;
  priority: string;
  fromAlias: string;
  parentTaskId: string | null;
  networkId: string | null;
  meta?: Record<string, unknown>;
}, dependencies: {
  send: (args: Record<string, unknown>) => Promise<any>;
  log: (line: string) => void;
}): Promise<any> {
  return sendTaskWithTrace({
    fromAlias: input.fromAlias,
    toAlias: input.alias,
    parentTaskId: input.parentTaskId,
    networkId: input.networkId,
    transport: "mcp_http",
    lifecycleTracking: "not_tracked",
  }, {
    log: dependencies.log,
    send: () => dependencies.send({
      alias: input.alias,
      task: input.task,
      priority: input.priority,
      from_session: input.fromAlias,
      parent_task_id: input.parentTaskId || undefined,
      ...(input.meta ? { meta: input.meta } : {}),
    }),
  });
}
