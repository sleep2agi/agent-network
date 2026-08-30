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

/* #1545 —— `create_capability_observed_ms_ago` 的**验证宽度**本身就是判据。
 *
 * 这一格是纯诊断信息(那个 can_create_nodes 是多久以前测出来的)。zod 对象里
 * 任何一个**已知字段**验证失败,整份 report_status 都会被拒 —— 不是丢掉这一格。
 * 所以给它加 `.int()/.min()/.max()` 等于:一台节点发了个奇怪的诊断数字,
 * 就在 hub 上整个失联。**#1225/#1498 已经用 host.ip 演过一遍这件事了。**
 *
 * 消毒在读取处(`/api/host-supervisors`),不在这里。 */
describe("#1545 create_capability_observed_ms_ago —— schema 必须收得宽", () => {
  const caps = () => schemas.report_status.config_snapshot;

  test("前提:抓到的确实是 config_snapshot 形状,且它接受 daemon_capabilities", () => {
    expect(caps()).toBeTruthy();
    const parsed = caps().parse({
      flags: {}, config_update_capable: false, peer_reply_inbox_capable: true,
      daemon_capabilities: { can_create_nodes: true },
    });
    expect(parsed.daemon_capabilities.can_create_nodes).toBe(true);
  });

  test("正常值:透传", () => {
    const parsed = caps().parse({
      flags: {}, config_update_capable: false, peer_reply_inbox_capable: true,
      daemon_capabilities: { can_create_nodes: true, create_capability_observed_ms_ago: 0 },
    });
    expect(parsed.daemon_capabilities.create_capability_observed_ms_ago).toBe(0);
  });

  test("null 必须被接受(显式「我没测过」和「我不发这一格」都要能表达)", () => {
    const parsed = caps().parse({
      flags: {}, config_update_capable: false, peer_reply_inbox_capable: true,
      daemon_capabilities: { can_create_nodes: true, create_capability_observed_ms_ago: null },
    });
    expect(parsed.daemon_capabilities.create_capability_observed_ms_ago).toBeNull();
  });

  /* 🔴 这四个值**一个都不许让整份 report 被拒**。它们在读取侧会被当成「没报」,
   *    但那是读取侧的事 —— 这一层的职责只有一个:别把节点踢下线。 */
  test.each([
    ["负数", -1],
    ["非整数", 1234.5678],
    ["超过一年", 400 * 24 * 60 * 60 * 1000],
    ["NaN", Number.NaN],
  ])("怪值不得拒掉整份 report_status:%s", (_label, value) => {
    expect(() => caps().parse({
      flags: {}, config_update_capable: false, peer_reply_inbox_capable: true,
      daemon_capabilities: { can_create_nodes: false,
        create_nodes_blocked_reason: "anet_bin_source",
        create_capability_observed_ms_ago: value },
    })).not.toThrow();
  });

  /* 🔴 反向锚:上面那组「不抛」如果只是因为**这个 key 压根没被 schema 看见**,
   * 它们会一样绿。所以这里证明 schema 确实在看它:喂一个非数字,值必须**被改写成
   * null**(而不是原样穿过去)。原样穿过去 = key 被忽略,那组测试就什么也没测。 */
  test("反向锚:非数字被改写成 null(不是原样穿过)⇒ 证明 schema 确实在看这个 key", () => {
    const parsed = caps().parse({
      flags: {}, config_update_capable: false, peer_reply_inbox_capable: true,
      daemon_capabilities: { can_create_nodes: true, create_capability_observed_ms_ago: "0" },
    });
    expect(parsed.daemon_capabilities.create_capability_observed_ms_ago).toBeNull();
    expect(parsed.daemon_capabilities.create_capability_observed_ms_ago).not.toBe("0");
  });
});

/* 🔴 #1545 —— 把 `host:` 上方那段方框注释里的表**钉住**。
 *
 * 那段注释说的是:这份 schema 的子对象一半 strict 一半不 strict,而「往里加一个
 * hub 还不认识的键」的后果完全相反 —— 非 strict 静默丢弃(节点活着、字段蒸发),
 * strict 拒掉整份 report(节点当场失联,#1225 的形状)。
 *
 * 注释会烂。这组测试的作用**不是禁止改 strict**(两种都各有其位),而是:谁改了,
 * 谁就会在这里撞红,从而**被迫连注释一起改**。所以断言写成「和注释里那张表一致」,
 * 而不是「必须是某个值」。 */
describe("#1545 report_status 子对象的 strict 分布(注释里那张表的可执行副本)", () => {
  const rs = () => schemas.report_status;
  const UNKNOWN = { __hub_does_not_know_this_key__: 1 };

  function acceptsUnknownKey(schema: any, base: object): "dropped" | "rejected" {
    try {
      const parsed = schema.parse({ ...base, ...UNKNOWN });
      return "__hub_does_not_know_this_key__" in parsed ? "rejected" /* 不可能:留着说明它根本没被处理 */ : "dropped";
    } catch { return "rejected"; }
  }

  const SIDE_THREAD = {
    supported: true, runtime: "codex", runtimeVersion: "1.0",
    topology: "native-exact-fork", evidenceRevision: "r1",
  };
  const SNAP_BASE = { flags: {}, config_update_capable: false, peer_reply_inbox_capable: true };

  test.each([
    ["host", () => rs().host, {}, "dropped"],
    ["process_telemetry", () => rs().process_telemetry, {}, "dropped"],
    ["config_snapshot", () => rs().config_snapshot, SNAP_BASE, "dropped"],
    ["external_schedules", () => rs().external_schedules, { schedules: [] }, "rejected"],
  ])("%s → 未知键被 %s", (_name, get, base, expected) => {
    expect(acceptsUnknownKey(get(), base)).toBe(expected as string);
  });

  test("daemon_capabilities(嵌在 config_snapshot 里)→ 未知键被丢弃,不拒整份", () => {
    const parsed: any = rs().config_snapshot.parse({
      ...SNAP_BASE,
      daemon_capabilities: { can_create_nodes: true, ...UNKNOWN },
    });
    expect(parsed.daemon_capabilities.can_create_nodes).toBe(true);
    expect("__hub_does_not_know_this_key__" in parsed.daemon_capabilities).toBe(false);
  });

  test("side_thread_capability(同一个 config_snapshot 里)→ 未知键拒掉**整份**", () => {
    expect(() => rs().config_snapshot.parse({
      ...SNAP_BASE,
      side_thread_capability: { ...SIDE_THREAD, ...UNKNOWN },
    })).toThrow();
    // 反向锚:去掉那个未知键必须过 —— 否则上面那条可能是被别的必填字段拒的,
    // 和 strict 无关。
    expect(() => rs().config_snapshot.parse({
      ...SNAP_BASE, side_thread_capability: SIDE_THREAD,
    })).not.toThrow();
  });

  /* 分母自证:上面这张表**两侧都有**。如果哪天全变成 dropped(或全 rejected),
   * 那段注释描述的「不对称」就不存在了,而这条会先红。 */
  test("这张表确实是不对称的(两种后果各至少一个)", () => {
    const results = [
      acceptsUnknownKey(rs().host, {}),
      acceptsUnknownKey(rs().process_telemetry, {}),
      acceptsUnknownKey(rs().config_snapshot, SNAP_BASE),
      acceptsUnknownKey(rs().external_schedules, { schedules: [] }),
    ];
    expect(results.filter(r => r === "dropped").length).toBeGreaterThan(0);
    expect(results.filter(r => r === "rejected").length).toBeGreaterThan(0);
  });
});
