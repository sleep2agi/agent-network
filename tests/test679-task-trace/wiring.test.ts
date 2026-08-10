import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(`/app/${path}`, "utf8");

describe("#167 three-entry trace denominator", () => {
  it("pins every production entry to its exact transport", () => {
    const explicit = read("agent-node/src/explicit-task-trace.ts");
    const sdk = read("agent-node/src/commhub-mcp.ts");
    const channel = read("agent-network/src/channel-task-trace.ts");
    const labels = [
      [explicit, 'transport: "mcp_http"'],
      [sdk, 'transport: "sdk_mcp_proxy"'],
      [channel, 'transport: "channel_mcp_proxy"'],
    ] as const;
    expect(labels.filter(([source, anchor]) => source.includes(anchor))).toHaveLength(3);
  });

  it("keeps proxy lifecycle explicitly untracked", () => {
    expect(read("agent-node/src/commhub-mcp.ts")).toContain('lifecycle_tracking: "not_tracked"');
    expect(read("agent-network/src/channel-task-trace.ts")).toContain('lifecycle_tracking: "not_tracked"');
    expect(read("agent-node/src/explicit-task-trace.ts")).toContain('lifecycle_tracking: "tracked"');
  });

  it("wires helpers into all three production entry files", () => {
    expect(read("agent-node/src/cli.ts")).toContain("sendExplicitTaskWithTrace");
    expect(read("agent-node/src/commhub-mcp.ts")).toContain('toolName === "send_task"');
    expect(read("agent-network/src/node-server.ts")).toContain("sendChannelTaskWithTrace");
  });
});
