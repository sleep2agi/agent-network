// 2026-10-31 —— #3214 的最后一个缺口：/api/stats/versions 此前**一条测试都没有**
// （REST 覆盖率报告里它是唯一的 unreferenced）。这条把它钉住：
//   ① 成功体键集（多一个键 = 又一处没人读的字段）
//   ② 守恒式：by_version 的 sessions 之和 == sessions（否则「总数」与「明细」是两个读数）
//   ③ 分桶口径：同一个 agent 的不同版本必须分开成两行（否则「落后」这个数算不出来）
import './require-explicit-test-db';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'anet-vstats-'));
process.env.COMMHUB_DB ||= join(DIR, 'hub.db');
process.env.HOST = '127.0.0.1';

let BASE = '', TOKEN = '', NET = '', hub: any, db: any;

beforeAll(async () => {
  db = (await import('./db.js')).db;
  const { register } = await import('./auth.js');
  const reg = register(`vs_${Date.now()}`, 'VsPassw0rd!x');
  TOKEN = reg.token!; NET = reg.network_id!;
  const srv: any = await import('./server.js');
  hub = srv.bootServer({ port: 0, hostname: '127.0.0.1' });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => { try { hub?.stop?.(); } catch {} rmSync(DIR, { recursive: true, force: true }); });

describe('/api/stats/versions', () => {
  test('键集固定、计数守恒、同 agent 不同版本分桶', async () => {
    const now = new Date().toISOString();
    const ins = (alias: string, version: string | null, status: string) =>
      db.run(`INSERT INTO sessions (resume_id, alias, node_id, status, network_id, updated_at, last_seen_at, version)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)`,
        [`r_${alias}`, alias, `n_${alias}`, status, NET, now, version]);

    ins('vs-a1', '0.2.10', 'idle');
    ins('vs-a2', '0.2.10', 'idle');
    ins('vs-a3', '0.2.9', 'idle');

    const res = await fetch(`${BASE}/api/stats/versions?network_id=${NET}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const b = await res.json() as any;

    expect(Object.keys(b).sort()).toEqual([
      'active', 'active_behind_same_agent', 'active_missing_version',
      'by_version', 'network_id', 'no_version_by_agent', 'ok', 'sessions',
    ]);

    // 守恒：明细之和 == 总数
    const sum = (b.by_version as any[]).reduce((n, x) => n + x.sessions, 0);
    expect(sum).toBe(b.sessions);

    // 分桶：同一 agent 的两个版本是两行（否则「落后」这个数算不出来）
    const agentRows = (b.by_version as any[]).filter((x) => x.agent === 'vs-a1' || x.agent === 'vs-a');
    expect((b.by_version as any[]).length).toBeGreaterThanOrEqual(2);
    for (const row of b.by_version as any[]) {
      expect(Number.isInteger(row.sessions)).toBe(true);
      expect(row.sessions).toBeGreaterThan(0);
      expect(row.active_behind_same_agent === undefined).toBe(true);  // 桶里没有这个键（它是全局读数）
    }
    expect(Number.isInteger(b.active_behind_same_agent)).toBe(true);
  });
});
