// #2571（第三轮）—— 每个目标自己的「投递→首次活动」p99 基线。
//
// 为什么需要（2026-10-27 实测）：
//   同一个「10 分钟没消费就报警」的判据，在两种节奏下表现完全相反 ——
//     7 天基线：delivered→首次活动 p50=1s p90=6s  p99=12min ⇒ >600s 只占 1.2%
//     某一晚：  p50=32s  p90=411s p99=1573s        ⇒ >600s 占 5.4%，其中 43% 最终成功
//   全局常数不可能同时适配“全员都在跑长 turn”和“某个节点单独卡死”。
//   ⇒ 判据改成 **age > max(全局下限, 该 alias 自己的 p99 × 1.5)**：
//     全队一起变慢 ⇒ 各自基线一起抬高，不炸屏；单个节点变慢 ⇒ 它自己的基线没高，立刻显形。
//
// 这张表只是**缓存**（派生数据）：算错了重算即可，不影响投递/回复语义。
// 样本不足（< MIN_SAMPLES）的 alias 不写行 ⇒ 巡逻退回全局阈值（行为与 .163 完全一致）。

import { db } from "./db.js";

export const ALIAS_BASELINE_TABLE = "alias_latency_baseline";
export const BASELINE_WINDOW_DAYS = 7;
export const BASELINE_MIN_SAMPLES = 20;
/** 阈值 = max(全局下限, p99 × 这个倍数)。1.5 是“比它自己最慢的 1% 再宽 50%”。 */
export const BASELINE_P99_FACTOR = 1.5;

export function ensureAliasBaselineTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ALIAS_BASELINE_TABLE} (
      alias        TEXT NOT NULL,
      network_id   TEXT NOT NULL,
      p99_seconds  INTEGER NOT NULL,
      samples      INTEGER NOT NULL,
      computed_at  TEXT NOT NULL,
      PRIMARY KEY (alias, network_id)
    );
    CREATE INDEX IF NOT EXISTS idx_alias_baseline_computed
      ON ${ALIAS_BASELINE_TABLE}(computed_at);
  `);
}

/**
 * 重新计算基线。只统计**成功任务**（replied）且已经进过 runtime 的样本：
 * 失败/未开始的任务会把“没消费”混进“消费慢”，两者不是一回事。
 */
export function refreshAliasBaseline(now = new Date()): { rows: number } {
  ensureAliasBaselineTable();
  const iso = now.toISOString();
  const since = new Date(now.getTime() - BASELINE_WINDOW_DAYS * 86_400_000).toISOString();
  const result = db.run(
    `INSERT INTO ${ALIAS_BASELINE_TABLE} (alias, network_id, p99_seconds, samples, computed_at)
     SELECT alias, network_id, CAST(seconds AS INTEGER), samples, ?2
       FROM (
         SELECT to_name AS alias,
                network_id,
                seconds,
                samples,
                ROW_NUMBER() OVER (PARTITION BY to_name, network_id ORDER BY seconds) AS rn,
                CAST(samples * 0.99 AS INTEGER) AS p99_rank
           FROM (
             SELECT to_name,
                    network_id,
                    (julianday(COALESCE(started_at, runtime_submitted_at, completed_at)) - julianday(delivered_at)) * 86400.0 AS seconds,
                    COUNT(*) OVER (PARTITION BY to_name, network_id) AS samples
               FROM tasks
              WHERE status = 'replied'
                AND delivered_at IS NOT NULL
                AND COALESCE(started_at, runtime_submitted_at, completed_at) IS NOT NULL
                AND created_at >= ?1
           )
       )
      WHERE samples >= ?3
        AND rn = MAX(1, p99_rank)
     ON CONFLICT(alias, network_id) DO UPDATE SET
       p99_seconds = excluded.p99_seconds,
       samples = excluded.samples,
       computed_at = excluded.computed_at`,
    [since, iso, BASELINE_MIN_SAMPLES],
  );
  // 窗口内没有样本的 alias（长期不活跃）不该继续用旧基线兜着。
  db.run(`DELETE FROM ${ALIAS_BASELINE_TABLE} WHERE computed_at < ?1`, [since]);
  return { rows: result.changes };
}

/** 只读查询（排障 / 测试用）。 */
export function aliasBaseline(alias: string, networkId: string): { p99Seconds: number; samples: number } | null {
  try {
    const row = db.get<{ p99_seconds: number; samples: number }>(
      `SELECT p99_seconds, samples FROM ${ALIAS_BASELINE_TABLE} WHERE alias = ?1 AND network_id = ?2`,
      alias, networkId,
    );
    return row ? { p99Seconds: Number(row.p99_seconds), samples: Number(row.samples) } : null;
  } catch {
    // 表还没建（老库/单测里没跑过 refresh）⇒ 当作没有基线。
    return null;
  }
}
