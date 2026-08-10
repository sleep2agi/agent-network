import { describe, expect, it } from "bun:test";
import { sendTaskWithTrace } from "/app/agent-network/src/task-trace";

const input = {
  fromAlias: "sender",
  toAlias: "target",
  parentTaskId: null,
  networkId: null,
  transport: "mcp_http" as const,
  lifecycleTracking: "not_tracked" as const,
};

describe("one-shot task trace semantics", () => {
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
