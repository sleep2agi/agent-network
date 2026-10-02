// #431 —— 量 GET /api/status 的线上字节和 Hub 侧 CPU,改前 / 改后各跑一遍(同一个脚本,SERVER_SRC 指向哪份 server/src)。
//
//   SERVER_SRC=<…/server/src> COMMHUB_DB=<temp>/hub.db HOME=<temp> bun tests/test-status-read-cache/bench.ts
//
// 夹具:306 行 sessions(生产同一网络的行数),字段长度按生产匿名统计配(task 均 70 字、output 偶有 1 KB、
// external_schedules / channels 约一半有)。全是合成值,没有任何真实别名 / 主机名。
// 负载:旧 agent-node 的别名解析读(节点令牌 + Accept: application/json + node 的 fetch 默认
// Accept-Encoding: gzip, deflate,不带 If-None-Match —— 实测 node 20/22/24 都是这样),
// 读写比照生产 15 分钟窗口:GET /api/status 2.2 次/秒 vs report_status 0.75 次/秒 → 每 3 次读之间改 1 行。
// 另外量:app / dashboard 的全量读、带 If-None-Match 的客户端。
// 输出 JSON 一行:每种读法的线上字节/次、Hub 处理耗时(/api/stats/routes,含 gzip)、缓存命中。
// 还会把若干固定场景的正文写到 OUT_DIR(若给了),用来和另一份 server 的输出逐字节比对。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = process.env.SERVER_SRC;
if (!SRC) throw new Error("need SERVER_SRC");
process.env.HOST = "127.0.0.1";
process.env.COMMHUB_UPLOADS_DIR ||= join(process.env.HOME ?? "/tmp", "uploads");
const { register, createNetworkTokenForNode } = await import(join(SRC, "auth.ts"));
const { db } = await import(join(SRC, "db.ts"));

const ROWS = Number(process.env.BENCH_ROWS ?? 306);
const N = Number(process.env.BENCH_READS ?? 300);
const owner = register(`bench_owner`, "BenchPassw0rd!");
const NET = owner.network_id!;
let rnd = 431;
const r = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
const words = "示例 任务 进展 构建 测试 部署 检查 汇报 节点 回复 the build passed and the report was sent ".split(" ");
const sentence = (n: number) => Array.from({ length: n }, () => words[Math.floor(r() * words.length)]).join(" ").slice(0, n);
for (let i = 0; i < ROWS; i++) {
  const node = `node_bench_${i}`, alias = i % 2 ? `示例节点-${i}` : `bench-node-${i}`;
  db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id) VALUES (?1, ?2, ?2, ?3, ?4)`, [node, alias, NET, owner.user!.user_id]);
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, status, network_id, task, output, project_dir, config_path, hostname, ip, server, agent, version, channels,
       external_schedules, tmux_name, session_id, model, cpu_load_1min, cpu_cores, mem_total_gb, mem_used_gb, mem_avail_gb, disk_total_gb, disk_used_gb, disk_avail_gb,
       process_rss_bytes, process_rss_mb, process_cpu_pct, process_uptime_seconds, process_in_flight_count, updated_at, last_seen_at, registered_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?10, ?12, ?13, ?14, ?15, ?16, ?17, ?18, '1.5', '8', '61.4', '26.9', '34.5', '491.8', '442.2', '29.4',
       121868288, 116.2, 0.2, 292866, 0, ?19, ?19, '2026-09-01 00:00:00')`,
    [`r_${node}`, alias, node, i % 5 < 3 ? "offline" : "idle", NET, i % 7 ? sentence(70 + Math.floor(r() * 130)) : null,
      i % 9 ? null : sentence(200 + Math.floor(r() * 800)), `/home/user/work/project-${i}`, i % 9 ? `/home/user/work/project-${i}/.anet/nodes/${alias}/config.json` : null,
      `sample-host-${i % 12}.example`, `10.0.${i % 255}.${(i * 7) % 255}`, i % 2 ? "agent-node:codex-app-server" : "agent-node:claude-code",
      i % 2 ? "2.5.0-preview.88" : null, i % 2 ? '["telegram"]' : null, i % 2 ? JSON.stringify([{ id: `s${i}`, every: 1800 }]) : null,
      i % 5 ? null : `bench-${i}`, i % 2 ? `sess_${i}_${"x".repeat(20)}` : null, i % 3 ? "gpt-5.6-sol" : null,
      `2026-10-02 0${i % 10}:${String(i % 60).padStart(2, "0")}:00`],
  );
}
const nodeToken = createNetworkTokenForNode(owner.user!.user_id, NET, "bench-node-8", "node_bench_8").token!;
const mod: any = await import(join(SRC, "server.ts"));
const hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
const BASE = `http://127.0.0.1:${hub.port}`;

// Fixed-scenario bodies for the cross-version byte compare.
if (process.env.OUT_DIR) {
  mkdirSync(process.env.OUT_DIR, { recursive: true });
  const dump = async (name: string, path: string, headers: Record<string, string>) => {
    const res = await fetch(`${BASE}${path}`, { headers: { ...headers, "Accept-Encoding": "identity" } });
    writeFileSync(join(process.env.OUT_DIR!, `${name}.json`), new Uint8Array(await res.arrayBuffer()));
  };
  await dump("resolver", `/api/status?network_id=${NET}`, { Authorization: `Bearer ${nodeToken}`, Accept: "application/json" });
  await dump("resolver-again", `/api/status?network_id=${NET}`, { Authorization: `Bearer ${nodeToken}`, Accept: "application/json" });
  await dump("full", `/api/status?network_id=${NET}`, { Authorization: `Bearer ${owner.token}` });
  await dump("light", `/api/status?network_id=${NET}&light=1`, { Authorization: `Bearer ${owner.token}` });
  await dump("alias", `/api/status?network_id=${NET}&alias=${encodeURIComponent("示例节点-7")}`, { Authorization: `Bearer ${owner.token}` });
  db.run(`UPDATE sessions SET status = 'working', task = '改过的任务', updated_at = '2026-10-02 12:00:00' WHERE node_id = 'node_bench_5'`);
  await dump("resolver-after-write", `/api/status?network_id=${NET}`, { Authorization: `Bearer ${nodeToken}`, Accept: "application/json" });
  await dump("full-after-write", `/api/status?network_id=${NET}`, { Authorization: `Bearer ${owner.token}` });
}

async function routeStats(): Promise<Map<string, { count: number; total_ms: number; bytes: number }>> {
  const res = await fetch(`${BASE}/api/stats/routes`, { headers: { Authorization: `Bearer ${owner.token}` } });
  const body = await res.json() as any;
  return new Map((body.routes ?? []).map((x: any) => [x.route, x]));
}

async function phase(name: string, opts: { headers: Record<string, string>; path: string; writeEvery: number; inm?: boolean }) {
  const before = (await routeStats()).get("GET /api/status") ?? { count: 0, total_ms: 0, bytes: 0 };
  let wire = 0, n304 = 0, etag: string | null = null;
  const t0 = performance.now();
  for (let k = 0; k < N; k++) {
    if (opts.writeEvery && k % opts.writeEvery === 0) {
      const i = Math.floor(r() * ROWS);
      db.run(`UPDATE sessions SET status = ?1, updated_at = ?2 WHERE node_id = ?3`, [r() < 0.5 ? "idle" : "working", `2026-10-02 1${k % 10}:00:${String(k % 60).padStart(2, "0")}`, `node_bench_${i}`]);
    }
    const headers: Record<string, string> = { ...opts.headers, "Accept-Encoding": "gzip, deflate" };
    if (opts.inm && etag) headers["If-None-Match"] = etag;
    const res = await fetch(`${BASE}${opts.path}`, { headers, decompress: false } as any);
    const buf = await res.arrayBuffer();
    wire += buf.byteLength;
    if (res.status === 304) n304++;
    etag = res.headers.get("etag") ?? etag;
  }
  const wall = performance.now() - t0;
  const after = (await routeStats()).get("GET /api/status")!;
  const count = after.count - before.count;
  return { phase: name, reads: N, write_every: opts.writeEvery || null, wire_bytes_per_read: Math.round(wire / N), status_304: n304,
    hub_ms_per_read: +((after.total_ms - before.total_ms) / count).toFixed(3), wall_ms_per_read: +(wall / N).toFixed(3) };
}

const resolver = { headers: { Authorization: `Bearer ${nodeToken}`, Accept: "application/json" }, path: `/api/status?network_id=${NET}` };
const full = { headers: { Authorization: `Bearer ${owner.token}` }, path: `/api/status?network_id=${NET}` };
const out: any[] = [];
// warm-up (JIT, prepared statements)
await phase("warmup", { ...resolver, writeEvery: 0 });
out.push(await phase("old-resolver, production read:write (1 write / 3 reads)", { ...resolver, writeEvery: 3 }));
out.push(await phase("old-resolver, no writes", { ...resolver, writeEvery: 0 }));
out.push(await phase("full (app/dashboard), 1 write / 3 reads", { ...full, writeEvery: 3 }));
out.push(await phase("full + If-None-Match, 1 write / 3 reads", { ...full, writeEvery: 3, inm: true }));
let cache: any = null;
try { cache = (await import(join(SRC, "status-read-cache.ts"))).statusCacheStats; } catch { /* baseline has no cache */ }
console.log(JSON.stringify({ server_src: SRC, rows: ROWS, results: out, cache }, null, 1));
hub.stop(true);
process.exit(0);
