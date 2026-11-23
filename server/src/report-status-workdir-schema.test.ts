// #5125 续 —— report_status.config_snapshot 必须保留 workdir 键。
// zod object 默认丢弃未知键：不写进 schema，daemon 报的 workdir 会被静默剥掉，
// /api/nodes 的 workdir_state 就永远是 not_reported（2026-11-22 临时节点实测踩到）。
import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

function snapshotSchema(): any {
  let captured: any = null;
  const server = new McpServer({ name: "t", version: "0" });
  const orig = (server as any).tool.bind(server);
  (server as any).tool = (name: string, ...rest: any[]) => {
    if (name === "report_status") {
      const shape = typeof rest[0] === "string" ? rest[1] : rest[0];
      captured = shape.config_snapshot;
    }
    return orig(name, ...rest);
  };
  registerTools(server as any);
  return captured;
}

describe("#5125 report_status.config_snapshot", () => {
  test('#5338 retains measured usage, explicit null, and legacy omission', () => {
    const schema = snapshotSchema(), value = {tokens:17, since:'2026-11-23', cost_usd:null};
    expect(schema.parse({usage_week:value}).usage_week).toEqual(value);
    expect(schema.parse({usage_week:null}).usage_week).toBeNull();
    expect(schema.parse({}).usage_week).toBeUndefined();
    expect(schema.parse({usage_week:{...value,tokens:-1},model:'m'})).toMatchObject({usage_week:null,model:'m'});
  });
  test("workdir 原样保留（不是被当未知键丢掉）", () => {
    const parsed = snapshotSchema().parse({ workdir: "/srv/work" });
    expect(parsed.workdir).toBe("/srv/work");
  });

  test("超长 workdir 只丢这一格，不拒整份快照", () => {
    const parsed = snapshotSchema().parse({ workdir: "x".repeat(5000), model: "m" });
    expect(parsed.workdir).toBeUndefined();
    expect(parsed.model).toBe("m");
  });
});
