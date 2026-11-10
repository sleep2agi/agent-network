// #2880 —— 节点级「不可服务」检测。
//
// 生产 24h（2026-10-28 按节点统计定时任务产出）：
//   TMA云盘欧      ok=  0  busy=35   ← 全天零产出
//   通信客户端欧   ok= 22  busy=17   ← 等得到
//   TMA需求欧     ok=140  busy=13   ← 等得到
//   通信欧        ok=192  busy= 0
//
// 结论：**「忙就快速失败」不能全局开**（会打掉别人等得到的那批成功），
// 但**节点级**的判断是安全的 —— 一个节点在窗口内「忙类失败很多、成功为零」，
// 才是「现在投进去必然白等 30 分钟」。
//
// 判据（三项同时成立，缺一不可）：
//   1. 窗口内忙类失败 >= MIN_FAILS（默认 5）—— 证据量够
//   2. 窗口内成功 == 0                  —— 不是「忙但能干成」
//   3. 窗口内至少有一次投递             —— 不会把「今天没排程」误判成不可服务
//
// 默认只记录（不改变任何派发行为）。开启 COMMHUB_NODE_BUSY_CIRCUIT=1 才把
// 「暂不投递」用于排程派发 —— 这一步是行为变更，所以留给人开。
import { db } from "./db.js";

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

export function circuitEnabled(): boolean {
  return String(process.env.COMMHUB_NODE_BUSY_CIRCUIT ?? "").trim() === "1";
}
export function circuitWindowHours(): number { return envInt("COMMHUB_NODE_BUSY_CIRCUIT_HOURS", 6, 1); }
export function circuitMinFails(): number { return envInt("COMMHUB_NODE_BUSY_CIRCUIT_FAILS", 5, 1); }
/**
 * 熔断期间**放探针**的间隔（小时）。
 *
 * 🔴 为什么必须有：熔断后完全不再投递 ⇒ 节点永远拿不到成功记录 ⇒ 永远解不开（死锁）。
 * 所以每 N 小时放一条探针任务：它若成功，replied 计数不再为 0，熔断自动解除。
 */
export function circuitProbeHours(): number { return envInt("COMMHUB_NODE_BUSY_CIRCUIT_PROBE_HOURS", 1, 1); }

/** 该节点最近一次**被投递**的时刻（ms）。没有投递过返回 null。 */
function lastDeliveryMs(alias: string, networkId: string | null): number | null {
  try {
    const row = db.get<{ t: string | null }>(
      "SELECT MAX(created_at) AS t FROM tasks WHERE to_name = ?1 AND (?2 IS NULL OR network_id = ?2)",
      alias, networkId,
    );
    if (!row?.t) return null;
    const ms = Date.parse(String(row.t).replace(" ", "T") + "Z");
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

export type NodeServingStats = { alias: string; network_id: string | null; delivered: number; replied: number; busy_failed: number };

/** 纯函数：三项判据同时成立才算「不可服务」。 */
export function isNotServing(
  s: { delivered: number; replied: number; busy_failed: number },
  minFails = circuitMinFails(),
): boolean {
  return s.busy_failed >= minFails && s.replied === 0 && s.delivered > 0;
}

export type CircuitScanResult = { tripped: string[]; enabled: boolean; windowHours: number };

export function scanNodeBusyCircuit(now = new Date()): CircuitScanResult {
  const windowHours = circuitWindowHours();
  const since = new Date(now.getTime() - windowHours * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  const rows = db.all<{ alias: string; network_id: string | null; delivered: number; replied: number; busy_failed: number }>(
    `SELECT t.to_name AS alias,
            t.network_id AS network_id,
            COUNT(*) AS delivered,
            SUM(CASE WHEN r.status = 'replied' THEN 1 ELSE 0 END) AS replied,
            SUM(CASE WHEN r.status = 'failed'
                      AND (r.error_code = 'task_failed_busy' OR t.result LIKE '%共享会话%')
                     THEN 1 ELSE 0 END) AS busy_failed
       FROM scheduled_task_runs r
       JOIN tasks t ON t.task_id = r.task_id
      WHERE r.created_at >= ?1 AND t.to_name IS NOT NULL
      GROUP BY t.to_name, t.network_id`,
    since,
  );
  const tripped = rows.filter((r) => isNotServing(r)).map((r) => r.alias);
  return { tripped, enabled: circuitEnabled(), windowHours };
}

/**
 * 这个节点现在能不能投递。默认永远 true（未开启 = 不拦截）。
 * 供排程派发判断；纯读，不改任何状态。
 */
export function nodeCanAcceptDispatch(alias: string, networkId: string | null): { ok: boolean; reason?: string; busy_failed?: number; probe?: boolean } {
  if (!circuitEnabled()) return { ok: true };
  const windowHours = circuitWindowHours();
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  const row = db.get<{ delivered: number; replied: number; busy_failed: number }>(
    `SELECT COUNT(*) AS delivered,
            SUM(CASE WHEN r.status = 'replied' THEN 1 ELSE 0 END) AS replied,
            SUM(CASE WHEN r.status = 'failed'
                      AND (r.error_code = 'task_failed_busy' OR t.result LIKE '%共享会话%')
                     THEN 1 ELSE 0 END) AS busy_failed
       FROM scheduled_task_runs r
       JOIN tasks t ON t.task_id = r.task_id
      WHERE r.created_at >= ?1 AND t.to_name = ?2
        AND (?3 IS NULL OR t.network_id = ?3)`,
    since, alias, networkId,
  );
  if (!row) return { ok: true };
  const stats = { delivered: Number(row.delivered ?? 0), replied: Number(row.replied ?? 0), busy_failed: Number(row.busy_failed ?? 0) };
  if (!isNotServing(stats)) return { ok: true };
  // 熔断期间每 N 小时放一条探针，否则节点永远拿不到成功记录、永远解不开。
  const probeHours = circuitProbeHours();
  const last = lastDeliveryMs(alias, networkId);
  if (last === null || Date.now() - last >= probeHours * 3_600_000) {
    return { ok: true, probe: true, busy_failed: stats.busy_failed };
  }
  return {
    ok: false,
    reason: `节点近 ${windowHours}h 内 ${stats.busy_failed} 次忙类失败、0 次成功（投递也只会白等），已跳过`,
    busy_failed: stats.busy_failed,
  };
}
