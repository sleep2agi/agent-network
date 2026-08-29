// #1281 — 子节点生命周期工具的参数名统一（node_id ⇄ child_node_id）。
//
// 分叉现状（origin/main 2976adb2）：stop_node / start_node / delete_node 用
// `child_node_id`，restart_node / update_node_config 用 `node_id`，指向同一个
// 子节点。调用方按一个工具的习惯给另一个传就吃 -32602。修复：5 个工具都同时
// 接受两个名字（canonical = node_id，child_node_id 兼容 alias），解析收敛到一个
// 模块级 helper resolveNodeIdArg。
//
// 两向 witnessed-red（本文件即判据）：
//   · schema 层：每个工具的**历史用名**始终 parse 成功（证明没破已发布契约），
//     **新增别名**在修复前 parse 失败（缺必填字段）、修复后成功。
//   · handler 层：resolveNodeIdArg 纯函数 —— 二选一至少一必填、都传须相等。
//   · 真实 handler 路径：stop_node 用 node_id / child_node_id 都能穿到
//     resolveDaemonForChild（不再被 node_id_required 挡），都传冲突 → node_id_conflict。
//
// 对 pre-fix 见红的证明方式（评审可复现）：把 tools.ts 里任一工具的
// `...NODE_ID_ALIAS_FIELDS` 还原成原来的单名字段（如 stop_node 的
// `child_node_id: z.string()...regex(...)`），本文件对应工具的「新增别名 parse 成功」
// 断言立即变红 —— 证明该断言有判别力，不是恒真。

import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

process.env.COMMHUB_DB = process.env.COMMHUB_DB || (mkdtempSync(join(tmpdir(), "anet-1281-")) + "/commhub.db");

import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, resolveNodeIdArg } from "./tools.js";

type ToolHandler = (args: any) => Promise<{ content: { type: "text"; text: string }[] }>;

// Capture BOTH the raw zod shape and the handler for every tool, so the
// schema-layer assertions run against the exact object server.tool received.
function buildCaptured() {
  const schemas: Record<string, any> = {};
  const handlers: Record<string, ToolHandler> = {};
  const server = new McpServer({ name: "t1281", version: "0" }) as any;
  const origTool = server.tool.bind(server);
  server.tool = (name: string, _desc: string, schema: any, handler: ToolHandler) => {
    schemas[name] = schema; handlers[name] = handler;
    return origTool(name, _desc, schema, handler);
  };
  const origRegisterTool = server.registerTool?.bind(server);
  if (origRegisterTool) {
    server.registerTool = (name: string, cfg: any, handler: ToolHandler) => {
      schemas[name] = cfg?.inputSchema ?? cfg; handlers[name] = handler;
      return origRegisterTool(name, cfg, handler);
    };
  }
  registerTools(server, undefined, null, "user_1281", null, false, null);
  return { schemas, handlers };
}

let SCHEMAS: Record<string, any> = {};
let HANDLERS: Record<string, ToolHandler> = {};
beforeAll(() => { const c = buildCaptured(); SCHEMAS = c.schemas; HANDLERS = c.handlers; });

async function call(name: string, args: any) {
  const r = await HANDLERS[name](args);
  return JSON.parse(r.content[0].text);
}

// Per tool: the historically-required id name, the newly-added alias, and
// the OTHER required fields the shape needs so a safeParse isolates the id
// field rather than tripping on an unrelated missing field.
const TOOLS = [
  { name: "stop_node",          historic: "child_node_id", added: "node_id",        extra: {} },
  { name: "start_node",         historic: "child_node_id", added: "node_id",        extra: {} },
  { name: "delete_node",        historic: "child_node_id", added: "node_id",        extra: { confirm_alias: "some-alias" } },
  { name: "restart_node",       historic: "node_id",       added: "child_node_id",  extra: {} },
  { name: "update_node_config", historic: "node_id",       added: "child_node_id",  extra: { base_revision: 0, patch: {} } },
];

const VALID_ID = "node_test_1281";

describe("#1281 schema layer — every lifecycle tool accepts BOTH node_id and child_node_id", () => {
  for (const t of TOOLS) {
    test(`${t.name}: historic name '${t.historic}' still parses (published contract intact)`, () => {
      const shape = z.object(SCHEMAS[t.name]);
      const r = shape.safeParse({ [t.historic]: VALID_ID, ...t.extra });
      expect(r.success).toBe(true);
    });

    test(`${t.name}: added alias '${t.added}' parses (was -32602 pre-#1281 → RED without the fix)`, () => {
      const shape = z.object(SCHEMAS[t.name]);
      const r = shape.safeParse({ [t.added]: VALID_ID, ...t.extra });
      expect(r.success).toBe(true);
    });

    test(`${t.name}: both names present + equal parses (schema layer permissive; conflict caught in handler)`, () => {
      const shape = z.object(SCHEMAS[t.name]);
      const r = shape.safeParse({ node_id: VALID_ID, child_node_id: VALID_ID, ...t.extra });
      expect(r.success).toBe(true);
    });
  }
});

describe("#1281 resolveNodeIdArg — the single resolution helper", () => {
  test("node_id only → resolves to node_id", () => {
    expect(resolveNodeIdArg({ node_id: "node_a" })).toEqual({ ok: true, node_id: "node_a" });
  });
  test("child_node_id only → resolves to it (back-compat)", () => {
    expect(resolveNodeIdArg({ child_node_id: "node_b" })).toEqual({ ok: true, node_id: "node_b" });
  });
  test("both present + EQUAL → resolves (no conflict)", () => {
    expect(resolveNodeIdArg({ node_id: "node_c", child_node_id: "node_c" })).toEqual({ ok: true, node_id: "node_c" });
  });
  test("both present + DIFFERENT → node_id_conflict (catches A/B fat-finger)", () => {
    const r = resolveNodeIdArg({ node_id: "node_a", child_node_id: "node_b" });
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe("node_id_conflict");
  });
  test("neither present → node_id_required", () => {
    const r = resolveNodeIdArg({});
    expect(r.ok).toBe(false);
    expect((r as any).error).toBe("node_id_required");
  });
});

describe("#1281 real handler path — stop_node routes both names to the same place", () => {
  // stop_node calls resolveNodeIdArg FIRST, then resolveDaemonForChild. A
  // fabricated id has no create-request row → daemon_not_resolvable. The
  // point is that BOTH names get PAST the id gate to that same downstream
  // error (proving the alias flows through), and the two error branches fire.
  test("node_id (new name) flows through → daemon_not_resolvable, NOT node_id_required", async () => {
    const r = await call("stop_node", { node_id: VALID_ID });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("daemon_not_resolvable");
  });
  test("child_node_id (old name) flows through → daemon_not_resolvable (back-compat intact)", async () => {
    const r = await call("stop_node", { child_node_id: VALID_ID });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("daemon_not_resolvable");
  });
  test("neither → node_id_required (before any daemon resolution)", async () => {
    const r = await call("stop_node", { force: true });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("node_id_required");
  });
  test("both differ → node_id_conflict (before any daemon resolution)", async () => {
    const r = await call("stop_node", { node_id: "node_a", child_node_id: "node_b" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("node_id_conflict");
  });
});
