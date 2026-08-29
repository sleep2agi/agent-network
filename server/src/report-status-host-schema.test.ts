// report_status 的 host 遥测 schema 必须接受 agent-node **声明会发**的 null。
//
// 来源不是推理，是 #1225 复现容器里量到的一次真崩：`--network none` 里
// agent-node 一启动就死在
//   MCP error -32602: Invalid input: expected string, received null at host.ip
// 而 register() 是 `await callCommHub("report_status", …)` 且没有 catch ——
// 于是**整个节点进程当场退出**，和 runtime 无关（opencode/claude/codex 一样）。
//
// 触发条件不是"容器"，是"这台机器没有非回环 IPv4"：
// agent-node 的 firstNonInternalIPv4()（host-telemetry.ts:48-59）在那种机器上
// 返回 null，而 HostTelemetry 的类型本来就写着 `ip: string | null`。
//
// 🔴 这里断言的是 **schema 本身**，不是 handler。直接调 handler 会绕过 zod ——
//    而缺陷恰恰只存在于 zod 那一层，绕过去就永远绿。
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

function captureToolSchemas(): Record<string, any> {
  const mcp = new McpServer({ name: "schema-probe", version: "0" }) as any;
  const schemas: Record<string, any> = {};
  const origTool = mcp.tool.bind(mcp);
  mcp.tool = (name: string, desc: string, schema: any, handler: any) => {
    schemas[name] = schema;
    return origTool(name, desc, schema, handler);
  };
  registerTools(mcp, undefined, null, null, null, false, "tok_schema_probe");
  return schemas;
}

const schemas = captureToolSchemas();

describe("report_status host telemetry schema", () => {
  test("前提：抓到的确实是 report_status 的 host 形状", () => {
    expect(schemas.report_status).toBeTruthy();
    expect(schemas.report_status.host).toBeTruthy();
  });

  test("🔴 host.ip = null 必须被接受（没有非回环 IPv4 的机器就是发 null）", () => {
    const host = schemas.report_status.host;
    const parsed = host.parse({ hostname: "boxy", ip: null });
    expect(parsed.ip).toBeNull();
  });

  test("🔴 host.hostname = null 同样被接受（与 ip 同为字符串字段，一起对齐）", () => {
    const host = schemas.report_status.host;
    expect(host.parse({ hostname: null, ip: "10.0.0.2" }).hostname).toBeNull();
  });

  test("agent-node 那条完整心跳负载整体过 schema", () => {
    // 形状抄自 agent-node/src/host-telemetry.ts 的 HostTelemetry：
    // 没有网络、没有 /proc 时每一项都可能是 null。
    const full = {
      hostname: "unknown", ip: null,
      cpu_load_1min: null, cpu_cores: null,
      mem_total_gb: null, mem_used_gb: null, mem_avail_gb: null,
      disk_total_gb: null, disk_used_gb: null, disk_avail_gb: null,
    };
    expect(() => schemas.report_status.host.parse(full)).not.toThrow();
  });

  test("放宽的只有 null —— 类型错的值仍然被拒", () => {
    const host = schemas.report_status.host;
    expect(() => host.parse({ ip: 12345 })).toThrow();
    expect(() => host.parse({ ip: "x".repeat(201) })).toThrow();
  });

  test("整条 report_status 负载（不只是 host 子对象）也接受 ip=null", () => {
    const full = z.object(schemas.report_status);
    expect(() => full.parse({
      resume_id: "probe-resume", alias: "probe-node", status: "idle",
      host: { hostname: "unknown", ip: null },
    })).not.toThrow();
  });
});
