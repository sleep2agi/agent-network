// 探针：target_offline 连续跳过后，next_run_at 到底被推到哪里？
// 生产现象（2026-10-28 08:45）：backoff_effective_seconds=5760，但实际间隔 360s。
// 这里用真实调度入口 dispatchScheduledOccurrence 复现，看 next_run_at 与实际 cadence。
// Run: COMMHUB_DB=/tmp/target-offline-backoff.db bun test src/scheduled-offline-backoff-probe.test.ts
import { describe, expect, test, beforeAll } from 'bun:test';
import { register } from './auth.js';
import { db } from './db.js';
import { dispatchScheduledOccurrence, getScheduleRow } from './scheduled-tasks.js';

const stamp = Date.now();
const TARGET_ID = `n_offb_${stamp}`, TARGET = `offb-${stamp}`;
let NET = '', USER = '';

function seed() {
  const id = `sched_offb_${crypto.randomUUID()}`;
  db.run(`INSERT INTO scheduled_tasks (schedule_id, network_id, created_by, name, target_node_id, target_alias,
      task_content, priority, schedule_type, schedule_json, timezone, status, next_run_at, overlap_policy)
    VALUES (?1,?2,?3,'offb',?4,?5,'x','normal','interval','{"type":"interval","every_seconds":180}','Asia/Shanghai','active',datetime('now','+3 minutes'),'skip')`,
    [id, NET, USER, TARGET_ID, TARGET]);
  return getScheduleRow(id)!;
}

beforeAll(() => {
  const owner = register(`offb_owner_${stamp}`, 'OffbOwnerPassw0rd!', undefined, 'seed');
  expect(owner.ok).toBe(true);
  NET = owner.network_id!; USER = owner.user!.user_id;
  db.run("INSERT INTO nodes (node_id, node_name, alias, runtime, network_id, owner_user_id) VALUES (?1,?2,?2,'codex',?3,?4)", [TARGET_ID, TARGET, NET, USER]);
  // 目标会话：10 分钟没心跳 ⇒ offline
  db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id, last_seen_at) VALUES (?1,?2,'idle',?3,?4,datetime('now','-10 minutes'))",
    [`r_offb_${stamp}`, TARGET, TARGET_ID, NET]);
});

describe('target_offline backoff 是否真的推后 next_run_at', () => {
  test('连续 4 次离线跳过后，next_run_at 应 ≈ now + effective（而不是 base 的倍数）', () => {
    const s = seed();
    const rows: any[] = [];
    for (let i = 0; i < 4; i++) {
      const at = new Date(Date.now() + i * 10).toISOString();
      const r = dispatchScheduledOccurrence(getScheduleRow(s.schedule_id)!, at, true, new Date());
      const after = db.get<any>("SELECT backoff_effective_seconds, backoff_streak, next_run_at FROM scheduled_tasks WHERE schedule_id = ?1", s.schedule_id);
      const nextMs = after.next_run_at ? Date.parse(String(after.next_run_at).replace(' ', 'T') + (String(after.next_run_at).endsWith('Z') ? '' : 'Z')) : NaN;
      rows.push({ i, status: r.status, eff: after.backoff_effective_seconds, streak: after.backoff_streak, next_raw: after.next_run_at, gap_s: Number.isFinite(nextMs) ? Math.round((nextMs - Date.parse(at))/1000) : 'NaN' });
    }
    console.log('每次 fire 后：', JSON.stringify(rows));
    const last = rows[rows.length - 1];
    // 断言：最后一次的 next_run_at 与 effective 同量级（允许 ±2 个 base 的容差）
    if (!last.eff) throw new Error('backoff_effective_seconds 始终为空：退避没有生效');
    if (last.gap_s < last.eff) throw new Error(`next_run_at 只推后 ${last.gap_s}s，但 effective=${last.eff}s`);
  });
});
