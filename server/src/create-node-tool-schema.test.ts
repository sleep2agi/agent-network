import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

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
