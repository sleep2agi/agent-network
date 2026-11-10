import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { z } from "zod";

type ToolHandler = (args: any) => Promise<any> | any;

function captureSchemas(): Record<string, Record<string, any>> {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const schemas: Record<string, Record<string, any>> = {};
  const origTool = server.tool.bind(server);
  server.tool = (name: string, desc: string, schema: any, handler: ToolHandler) => {
    schemas[name] = schema;
    return origTool(name, desc, schema, handler);
  };
  registerTools(server, undefined, null, "u_schema_test", "schema-test", false, null);
  return schemas;
}

describe("create_node MCP schema", () => {
  test("source_ref is rejected instead of stripped into ordinary creation", () => {
    const schema = z.object(captureSchemas().create_node);
    const base = { daemon_node_id: "daemon_fixture", node_spec: { name: "source-node", runtime: "opencode-cli" } };
    for (const source_ref of ["src_fixture", null, "", {}]) {
      expect(schema.safeParse({ ...base, source_ref }).success).toBe(false);
      expect(schema.safeParse({ ...base, node_spec: { ...base.node_spec, source_ref } }).success).toBe(false);
    }
    expect(schema.safeParse(base).success).toBe(true);
  });
  test("#829 rejects misplaced V2 controls instead of stripping them", () => {
    const nodeSpec = captureSchemas().create_node.node_spec;
    const base = { name: "v2-node", runtime: "opencode-cli" };
    expect(nodeSpec.safeParse({ ...base, opencodeGeneration: "v2" }).success).toBe(false);
    expect(nodeSpec.safeParse({ ...base, opencodeUnsafeTools: true }).success).toBe(false);
    expect(nodeSpec.safeParse({ ...base, opencodeNewServer: true }).success).toBe(false);
    const flags = { opencodeGeneration: "v2", opencodeUnsafeTools: true };
    expect(nodeSpec.parse({ ...base, flags }).flags).toEqual(flags);
    expect(nodeSpec.parse(base)).toEqual(base);
  });
  test("model is optional on daemon create specs but empty strings stay invalid", () => {
    const schemas = captureSchemas();
    const nodeSpec = schemas.create_node.node_spec;

    expect(nodeSpec.safeParse({
      name: "child",
      runtime: "claude-agent-sdk",
    }).success).toBe(true);
    expect(nodeSpec.safeParse({
      name: "child",
      runtime: "claude-agent-sdk",
      model: null,
    }).success).toBe(true);
    expect(nodeSpec.safeParse({
      name: "child",
      runtime: "claude-agent-sdk",
      model: "",
    }).success).toBe(false);
  });
});
