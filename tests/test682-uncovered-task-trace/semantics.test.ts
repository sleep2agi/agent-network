import { describe, expect, it } from "bun:test";
import { sendTaskWithTrace } from "/app/agent-network/src/task-trace";
import { sendClientTaskWithTrace } from "/app/agent-network/src/client-task-trace";
import { sendPeerReplyTaskWithTrace } from "/app/agent-node/src/peer-reply-task-trace";

const input = {
  fromAlias: "sender",
  toAlias: "target",
  parentTaskId: null,
  networkId: null,
  transport: "mcp_http" as const,
  lifecycleTracking: "not_tracked" as const,
};

describe("one-shot task trace semantics", () => {
  it("preserves the public client response object and exact send invocation", async () => {
    const result = { ok: true, message_id: "client_shape" };
    let calls = 0;
    expect(await sendClientTaskWithTrace({ alias: "target", fromAlias: "sender" }, {
      log: () => {},
      send: async () => { calls += 1; return result; },
    })).toBe(result);
    expect(calls).toBe(1);
  });

  it("preserves the peer response object and exact RFC-030 send arguments", async () => {
    const result = { ok: true, message_id: "peer_shape" };
    let args: Record<string, unknown> | null = null;
    expect(await sendPeerReplyTaskWithTrace({
      alias: "target", task: "reply body", priority: "high", fromAlias: "sender",
      parentTaskId: "parent_exact", networkId: "network_exact",
    }, {
      log: () => {},
      send: async (value) => { args = value; return result; },
    })).toBe(result);
    expect(args).toEqual({
      alias: "target", task: "reply body", priority: "high",
      from_session: "sender", parent_task_id: "parent_exact",
    });
  });

  it("returns a successful MCP envelope unchanged and records its canonical task id", async () => {
    const result = { content: [{ type: "text", text: JSON.stringify({ ok: true, task_id: "task_envelope" }) }] };
    const lines: string[] = [];
    expect(await sendTaskWithTrace(input, { send: async () => result, log: (line) => lines.push(line) })).toBe(result);
    expect(lines.join("\n")).toContain("delivered");
    expect(lines.join("\n")).toContain("task_id=task_envelope");
    expect(lines.join("\n")).toContain("lifecycle=not_tracked");
  });

  it("returns an app-level rejection unchanged while logging a redacted failure", async () => {
    const result = { ok: false, error: "denied Bearer ntok_secret-value" };
    const lines: string[] = [];
    expect(await sendTaskWithTrace(input, { send: async () => result, log: (line) => lines.push(line) })).toBe(result);
    expect(lines.join("\n")).toContain("failed");
    expect(lines.join("\n")).toContain("send_rejected");
    expect(lines.join("\n")).not.toContain("ntok_secret-value");
  });

  it("treats an offline queued task id as a durable delivery receipt", async () => {
    const result = { ok: false, error: "alias_offline", queued: true, task_id: "task_queued" };
    const lines: string[] = [];
    expect(await sendTaskWithTrace(input, { send: async () => result, log: (line) => lines.push(line) })).toBe(result);
    expect(lines.join("\n")).toContain("delivered");
    expect(lines.join("\n")).toContain("task_id=task_queued");
    expect(lines.join("\n")).not.toContain("send_rejected");
  });

  it("preserves transport exceptions and records missing task ids without changing responses", async () => {
    const error = new Error("network down");
    const thrownLines: string[] = [];
    await expect(sendTaskWithTrace(input, { send: async () => { throw error; }, log: (line) => thrownLines.push(line) })).rejects.toBe(error);
    expect(thrownLines.join("\n")).toContain("send_failed");

    const missing = { ok: true, value: "unchanged" };
    const missingLines: string[] = [];
    expect(await sendTaskWithTrace(input, { send: async () => missing, log: (line) => missingLines.push(line) })).toBe(missing);
    expect(missingLines.join("\n")).toContain("missing_task_id");
  });
});
