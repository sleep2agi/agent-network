import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleStopDoorbell } from "../../agent-node/src/runtime/stop-daemon.js";

test("Windows stopped and stop_failed payloads satisfy the actual registered Hub schema", async () => {
  const root = mkdtempSync(join(tmpdir(), "windows-stop-wire-"));
  process.env.COMMHUB_DB = join(root, "hub.db");
  const { registerTools } = await import("./tools.js");
  const server = new McpServer({ name: "windows-stop-wire", version: "0" });
  let schema: z.ZodType | undefined;
  const tool = server.tool.bind(server);
  (server as any).tool = (name: string, description: string, shape: any, handler: any) => {
    if (name === "ack_stop_request") schema = z.object(shape);
    return tool(name, description, shape, handler);
  };
  registerTools(server);
  expect(schema).toBeDefined();
  const nodes = join(root, ".anet", "nodes");
  mkdirSync(join(nodes, "child"), { recursive: true });
  writeFileSync(join(nodes, "child", "config.json"), JSON.stringify({ node_id: "node_child", runtime: "claude-agent-sdk" }));
  try {
    for (const ok of [true, false]) {
      const acks: any[] = [];
      await handleStopDoorbell({ request_id: "sr_wire" }, {
        platform: "win32", workdirRoot: nodes, log() {}, warn() {},
        stopCopresenceNode: async () => ({ ok, detail: "WINDOWS_SDK_OWNER_RECEIPT_REQUIRED" }),
        callCommHub: async (name, args) => {
          if (name === "get_stop_request") return { ok: true, child_node_id: "node_child", child_alias: "child", action: "stop" };
          schema!.parse(args); acks.push(args); return { ok: true };
        },
      });
      expect(acks).toHaveLength(1);
      expect(acks[0].status).toBe(ok ? "stopped" : "stop_failed");
      if (ok) expect(acks[0].exit_signal).toBe("taskkill");
      else expect(acks[0].error).toContain("RECEIPT_REQUIRED");
    }
    expect(schema!.safeParse({ request_id: "sr_wire", status: "stopped", exit_signal: "WINDOWS_PROCESS_TREE" }).success).toBe(false);
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
});
