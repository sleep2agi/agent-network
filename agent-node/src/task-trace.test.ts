import { describe, expect, it } from "bun:test";
import { renderTaskTrace, safeTaskTraceError, taskTraceEvent } from "./task-trace";

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
});
