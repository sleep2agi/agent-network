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
      "acked_at", "created_at", "error", "observed_status", "requested_model", "requested_variant",
      "resolved_after_queue", "status", "terminal", "update_id",
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

// ── #4499 ────────────────────────────────────────────────────────────────────
// 现象（2026-11-10 生产实测，通信欧）：档位被拒（busy）→ 节点排队 → 29s 后真的应用上了
// → 顶层 modelVariant 已变 → 但 last_update 永远停在 rejected/variant_busy，
// 客户端于是一直显示「被拒绝」，而它其实已经生效。
//
// 判据（三条同时成立才算已生效，缺一条都保持 rejected）：
//   ① ack 原因是 variant_busy；② patch 里确实要了档位；③ 节点当前回读的档位 == 请求值。
// 另加 15 分钟时间窗；`applied` 仍然只代表「写入并回读一致」，不用「已排队」冒充。
describe("#4499 被拒后排队已生效的下发", () => {
  const busyRow = (over: Record<string, unknown> = {}) => ({
    update_id: "cu_busy",
    status: "rejected",
    patch_json: JSON.stringify({ modelVariant: "high" }),
    error: "variant_busy (in_flight=1, turn_age_ms=31421)",
    created_at: "1793519656437",
    acked_at: "1793519656466",
    ...over,
  });
  const now = 1793519656437 + 29_000; // 29 秒后：正是生产里实际应用的时刻

  test("回读档位 == 请求值 ⇒ 投影成 applied，但保留原始 rejected 与标记", () => {
    const v = projectLastConfigUpdate(busyRow(), { currentVariant: "high", nowMs: now });
    expect(v.status).toBe("applied");
    expect(v.terminal).toBe(true);
    expect(v.error).toBeNull();
    expect(v.resolved_after_queue).toBe(true);
    expect(v.observed_status).toBe("rejected"); // 原始事实不丢
    expect(v.requested_variant).toBe("high");
  });

  test("回读档位对不上 ⇒ 保持 rejected（不许猜）", () => {
    const v = projectLastConfigUpdate(busyRow(), { currentVariant: "low", nowMs: now });
    expect(v.status).toBe("rejected");
    expect(v.resolved_after_queue).toBe(false);
    expect(v.error).toContain("variant_busy");
  });

  test("没有回读上下文 ⇒ 保持 rejected（不可能凭 patch 猜）", () => {
    const v = projectLastConfigUpdate(busyRow(), { nowMs: now });
    expect(v.status).toBe("rejected");
    expect(v.resolved_after_queue).toBe(false);
  });

  test("超过 15 分钟窗口 ⇒ 不假设已生效", () => {
    const late = 1793519656437 + 16 * 60 * 1000;
    const v = projectLastConfigUpdate(busyRow(), { currentVariant: "high", nowMs: late });
    expect(v.status).toBe("rejected");
    expect(v.resolved_after_queue).toBe(false);
  });

  test("原因不是 variant_busy ⇒ 不参与这个推断（例如 session 没起）", () => {
    const v = projectLastConfigUpdate(
      busyRow({ error: "OpenCode V2 session is not running; model was not changed" }),
      { currentVariant: "high", nowMs: now },
    );
    expect(v.status).toBe("rejected");
    expect(v.resolved_after_queue).toBe(false);
  });

  test("patch 里没有 modelVariant ⇒ 与档位无关，不推断", () => {
    const v = projectLastConfigUpdate(busyRow({ patch_json: JSON.stringify({ model: "a/b" }) }), {
      currentVariant: "high",
      nowMs: now,
    });
    expect(v.status).toBe("rejected");
    expect(v.resolved_after_queue).toBe(false);
    expect(v.requested_variant).toBeNull();
  });

  test("要求清空（modelVariant:null / \"default\"）⇒ 与回读的 null 相等才算生效", () => {
    for (const patch of [{ modelVariant: null }, { modelVariant: "default" }]) {
      const applied = projectLastConfigUpdate(busyRow({ patch_json: JSON.stringify(patch) }), {
        currentVariant: null,
        nowMs: now,
      });
      expect(applied.status).toBe("applied");
      const notApplied = projectLastConfigUpdate(busyRow({ patch_json: JSON.stringify(patch) }), {
        currentVariant: "high",
        nowMs: now,
      });
      expect(notApplied.status).toBe("rejected");
    }
  });

  test("真的 applied 行不受影响：resolved_after_queue=false 且 requested_variant 仍然带出", () => {
    const v = projectLastConfigUpdate(busyRow({ status: "applied", error: null }), {
      currentVariant: "high",
      nowMs: now,
    });
    expect(v.status).toBe("applied");
    expect(v.resolved_after_queue).toBe(false);
    expect(v.requested_variant).toBe("high");
  });

  test("接线：GET /api/nodes/:id/config 把当前档位传给投影", () => {
    const block = configGetHandler();
    expect(block).toContain("currentVariant:");
    expect(block).toContain("modelVariant");
  });
});
