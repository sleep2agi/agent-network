import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(`/app/${path}`, "utf8");

describe("#167 known-uncovered send_task sites", () => {
  it("routes the RFC-030 peer-reply task through its trace wrapper", () => {
    const cli = read("agent-node/src/cli.ts");
    expect(cli.match(/sendPeerReplyTaskWithTrace\(/g)?.length).toBe(1);
    expect(cli).toContain([
      "const taskResult = await sendPeerReplyTaskWithTrace({",
      "      alias: target,",
      "      task: replyTask.task,",
      "      priority: replyTask.priority,",
      "      fromAlias,",
      "      parentTaskId: taskId || null,",
      "      networkId: NETWORK_ID || null,",
    ].join("\n"));
  });

  it("routes the public AgentClient send path through its trace wrapper", () => {
    const client = read("agent-network/src/client.ts");
    expect(client.match(/sendClientTaskWithTrace\(/g)?.length).toBe(1);
    expect(client).toContain("return sendClientTaskWithTrace({ alias: targetAlias, fromAlias: this.alias }, {");
  });

  it("marks both one-shot senders as MCP HTTP without fabricated lifecycle tracking", () => {
    for (const file of ["agent-node/src/peer-reply-task-trace.ts", "agent-network/src/client-task-trace.ts"]) {
      const source = read(file);
      expect(source).toContain('transport: "mcp_http"');
      expect(source).toContain('lifecycleTracking: "not_tracked"');
    }
  });
});
