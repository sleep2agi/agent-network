import { describe, expect, it } from "bun:test";
import { renderTaskTrace, safeTaskTraceError, taskTraceEvent } from "./task-trace";
import { sendExplicitTaskWithTrace } from "./explicit-task-trace";

describe("task trace contract", () => {
  it("renders missing parent and lifecycle scope honestly", () => {
    const line = renderTaskTrace(taskTraceEvent({
      from_alias: "sender", to_alias: "worker", task_id: null, parent_task_id: null,
      network_id: "net_x", transport: "sdk_mcp_proxy", status: "sending",
      duration_ms: 0, lifecycle_tracking: "not_tracked",
    }), false);
    expect(line).toContain("parent_task_id=<missing>");
    expect(line).toContain("transport=sdk_mcp_proxy");
    expect(line).toContain("lifecycle=not_tracked");
  });

  it("redacts credentials from errors", () => {
    expect(safeTaskTraceError("Bearer ntok_secret-value\nnext")).toBe("[REDACTED] next");
  });

  it("emits parseable JSON and neutralizes human log injection", () => {
    const event = taskTraceEvent({
      from_alias: "sender\nforged", to_alias: "worker", task_id: "task_1", parent_task_id: null,
      network_id: null, transport: "mcp_http", status: "delivered", duration_ms: 4,
      lifecycle_tracking: "tracked",
    });
    expect(JSON.parse(renderTaskTrace(event, true))).toEqual(event);
    expect(renderTaskTrace(event, false)).not.toContain("\n");
  });

  it("recognizes the real MCP content envelope before cli parsing", async () => {
    const lines: string[] = [];
    await sendExplicitTaskWithTrace({ alias: "worker", task: "x" }, {
      fromAlias: "sender", toAlias: "worker", parentTaskId: null, networkId: null,
      startedAt: Date.now(), log: (line) => lines.push(line),
    }, async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, task_id: "task_wire" }) }] }));
    expect(lines.join("\n")).toContain("delivered");
    expect(lines.join("\n")).toContain("task_id=task_wire");
    expect(lines.join("\n")).not.toContain("missing_task_id");
  });

  it("uses stable event names for send and observed lifecycle phases", () => {
    const base = {
      from_alias: "sender", to_alias: "worker", task_id: "task_1", parent_task_id: null,
      network_id: null, transport: "mcp_http" as const, duration_ms: 1,
      lifecycle_tracking: "tracked" as const,
    };
    expect(taskTraceEvent({ ...base, status: "sending" }).event).toBe("task.send.start");
    expect(taskTraceEvent({ ...base, status: "delivered" }).event).toBe("task.send.delivered");
    expect(taskTraceEvent({ ...base, status: "acked" }).event).toBe("task.ack");
    expect(taskTraceEvent({ ...base, status: "started" }).event).toBe("task.started");
    expect(taskTraceEvent({ ...base, status: "replied" }).event).toBe("task.replied");
    expect(taskTraceEvent({ ...base, status: "expired" }).event).toBe("task.expired");
  });
});
