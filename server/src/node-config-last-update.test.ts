// #3146 —— 「上一次切模型的结局」必须能被读到，而不是只能靠 revision 没涨推断成超时。
//
// 生产证据（2026-11-01，通信欧 n_28e6b2c2）：库里两行
//   status='rejected'  error='OpenCode V2 session is not running; model was not changed'
// 而界面写的是「已下发 xai/grok-4.7，但 90s 内节点没有以新模型回来，请去看日志」。
// 答案在库里，读者拿不到 —— 这个文件钉住「拿得到」与「拿到的形状对」。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_UPDATE_STATUSES,
  projectLastConfigUpdate,
  readLastConfigUpdate,
} from "./node-config-last-update.js";

const row = (over: Partial<Parameters<typeof projectLastConfigUpdate>[0]> = {}) => ({
  update_id: "cu_1",
  status: "rejected",
  patch_json: JSON.stringify({ model: "xai/grok-4.7", flags: {} }),
  error: "OpenCode V2 session is not running; model was not changed",
  created_at: "1793519656437",
  acked_at: "1793519656466",
  ...over,
});

describe("#3146 上一次配置下发的投影", () => {
  test("rejected ⇒ 原因原样带出（不是变成 timeout）", () => {
    const v = projectLastConfigUpdate(row());
    expect(v.status).toBe("rejected");
    expect(v.error).toBe("OpenCode V2 session is not running; model was not changed");
    expect(v.requested_model).toBe("xai/grok-4.7");
    expect(v.terminal).toBe(true);
  });

  test("时间列是 TEXT 存的 ms epoch ⇒ 转成 ISO；转不出就 null（不出现 Invalid Date）", () => {
    const v = projectLastConfigUpdate(row());
    expect(v.created_at).toBe(new Date(1793519656437).toISOString());
    expect(v.acked_at).toBe(new Date(1793519656466).toISOString());
    for (const bad of ["", "not-a-number", "0", "-5", null]) {
      expect(projectLastConfigUpdate(row({ created_at: bad as any })).created_at).toBeNull();
    }
    expect(JSON.stringify(projectLastConfigUpdate(row({ acked_at: "x" as any })))).not.toContain("Invalid Date");
  });

  test("闭集外的 status ⇒ unknown + 原值带出，且**不**当成终点（不折叠成最乐观那一档）", () => {
    const v = projectLastConfigUpdate(row({ status: "cancelled" }));
    expect(v.status).toBe("unknown");
    expect(v.observed_status).toBe("cancelled");
    expect(v.terminal).toBe(false);
  });

  test("闭集内的每一档都有明确的 terminal 取值（枚举与映射不许脱节）", () => {
    const terminal = Object.fromEntries(
      CONFIG_UPDATE_STATUSES.map((s) => [s, projectLastConfigUpdate(row({ status: s })).terminal]),
    );
    expect(terminal).toEqual({ pending: false, restarting: false, applied: true, rejected: true, timeout: true });
  });

  test("applied ⇒ error 为 null（成功时不许带一条陈旧原因）", () => {
    const v = projectLastConfigUpdate(row({ status: "applied", error: null }));
    expect(v.status).toBe("applied");
    expect(v.error).toBeNull();
  });

  test("patch_json 没有 model 或不是 JSON ⇒ requested_model 为 null（不猜）", () => {
    expect(projectLastConfigUpdate(row({ patch_json: "{}" })).requested_model).toBeNull();
    expect(projectLastConfigUpdate(row({ patch_json: "{oops" })).requested_model).toBeNull();
    expect(projectLastConfigUpdate(row({ patch_json: null })).requested_model).toBeNull();
  });

  test("不投影 created_by_token（凭据标识不是界面信息）", () => {
    const v: any = projectLastConfigUpdate(row() as any);
    expect(Object.keys(v).sort()).toEqual([
      "acked_at", "created_at", "error", "observed_status", "requested_model", "status", "terminal", "update_id",
    ]);
    expect(JSON.stringify(v)).not.toContain("created_by_token");
  });

  test("readLastConfigUpdate：从未下发 ⇒ null；多行取最新（created_at 降序）", () => {
    const rows: Record<string, any> = {
      cu_old: row({ update_id: "cu_old", status: "applied", created_at: "1000", error: null }),
      cu_new: row({ update_id: "cu_new", status: "rejected", created_at: "2000" }),
    };
    let seenSql = "";
    const get = (sql: string, _nodeId: string) => {
      seenSql = sql;
      return rows.cu_new;
    };
    expect(readLastConfigUpdate(get, "n_x")?.update_id).toBe("cu_new");
    expect(seenSql).toContain("ORDER BY created_at DESC");
    expect(readLastConfigUpdate(() => null, "n_x")).toBeNull();
  });

  test("镜像：读到的 rejected 里必须**同时**有 error 与 requested_model（缺一个就说不清失败在哪一层）", () => {
    const v = projectLastConfigUpdate(row());
    expect(v.error).not.toBeNull();
    expect(v.requested_model).not.toBeNull();
  });
});

// ── 接线：投影写对了，但如果 handler 没把它放进响应里，客户端仍然拿不到 ──
//
// 纯函数测试管不住这一层（`readLastConfigUpdate` 全绿而响应里没有 last_update 是完全可能的）。
// 判据用**守卫位置**：这一格必须出现在 「GET /api/nodes/:id/config」那段 handler 的响应对象里，
// 而不是文件里任何一处。判据域只到「文本级 + 一次变量解析」，不假装运行期全覆盖。
const serverSrc = readFileSync(join(import.meta.dir, "server.ts"), "utf8");

function configGetHandler(): string {
  const start = serverSrc.indexOf("const nodeConfigMatch = url.pathname.match(");
  expect(start).toBeGreaterThan(-1);
  const end = serverSrc.indexOf("// ── #462", start);
  expect(end).toBeGreaterThan(start);
  return serverSrc.slice(start, end);
}

describe("#3146 GET /api/nodes/:id/config 的接线", () => {
  test("响应对象里有 last_update（读的是 node_config_updates 的最近一行）", () => {
    const block = configGetHandler();
    expect(block).toContain("readLastConfigUpdate(");
    expect(block).toContain("last_update: lastUpdate");
  });

  test("镜像否定：不投影 created_by_token（凭据标识不进响应）", () => {
    expect(configGetHandler()).not.toContain("created_by_token");
  });
});
