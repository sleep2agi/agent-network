// 旧版 agent-node(< 2.5.0-preview.93)找自己别名的全量 /api/status 读法 → light 投影 + node_id。
//
// 背景(2026-10-01,app「连接较慢」#431):生产上约 2.3 次/秒的全量状态读(~93 KB gzip)几乎都来自旧节点的
// CurrentAliasResolver,它只读 sessions[].node_id / .alias,且 2.5 s 硬超时。经 RELAY frp 隧道到国内机器时常常
// 读不完就中止,Hub 已经推进隧道的字节被丢掉(约占隧道 60%)。这里钉住:
//   - 签名只认「节点令牌 + Accept 恰好 application/json + 只有 network_id」(statusAliasResolverRead);
//   - 命中时回 light + node_id,旧解析器照旧解析出别名(含改名之后);
//   - 不命中的(用户令牌 / CLI 不带 Accept / 浏览器 */* / light / node_id / alias / full=1 / 多值 Accept)字节不变;
//   - 量体积:同一批行,完整投影 vs 这条读法的 gzip 字节。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { gzipSync } from "zlib";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";
import { statusAliasResolverRead } from "./status-alias-resolver.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-status-alias-resolver-"));
let BASE = "";
let hub: any = null;
const PW = "StatusAliasResolverPassw0rd!";
let userToken = "", userId = "", NET = "";
let nodeToken = "";
const ROWS = 120;

function seed(i: number) {
  const node = `node_sar_${i}`, alias = `sar-${i}`;
  db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id) VALUES (?1, ?2, ?2, ?3, ?4)`, [node, alias, NET, userId]);
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, status, network_id, task, output, project_dir, config_path, hostname, ip, server, agent, version,
       cpu_load_1min, cpu_cores, mem_total_gb, mem_used_gb, mem_avail_gb, disk_total_gb, disk_used_gb, disk_avail_gb,
       process_rss_bytes, process_rss_mb, process_cpu_pct, process_uptime_seconds, process_in_flight_count, updated_at, last_seen_at, registered_at)
     VALUES (?1, ?2, ?3, 'idle', ?4, ?5, ?6, ?7, ?8, ?9, '10.0.0.' || ?10, ?9, 'agent-node:codex-app-server', '2.5.0-preview.88',
       '1.5', '8', '61.4', '26.9', '34.5', '491.8', '442.2', '29.4', 121868288, 116.2, 0.2, 292866, 0,
       datetime('now', '-' || ?10 || ' seconds'), datetime('now'), datetime('now', '-30 days'))`,
    [`r_${node}`, alias, node, NET, `示例任务 ${i}:`.repeat(12), `示例输出 ${i} `.repeat(20), `/home/sample/project-${i}`,
      `/home/sample/project-${i}/.anet/nodes/${alias}/config.json`, `sample-host-${i % 4}`, i],
  );
}

async function req(path: string, headers: Record<string, string>) {
  const res = await fetch(`${BASE}${path}`, { headers: { "Accept-Encoding": "gzip", ...headers } });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as any, projection: res.headers.get("x-status-projection") };
}
const asNode = (accept?: string) => ({ Authorization: `Bearer ${nodeToken}`, ...(accept !== undefined ? { Accept: accept } : {}) });
const gz = (s: string) => gzipSync(Buffer.from(s)).length;

// The exact call agent-node 2.5.0-preview.32 … .90 makes (dist/cli.js CurrentAliasResolver.fetchCanonicalAlias).
async function oldResolver(nodeId: string, token: string, networkId: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const url = `${BASE}/api/status${networkId ? `?network_id=${encodeURIComponent(networkId)}` : ""}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    try {
      const res = await fetch(url, { headers, signal: ctl.signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { sessions?: Array<{ node_id?: string; alias?: string }> };
      return body.sessions?.find((s) => s.node_id === nodeId)?.alias ?? null;
    } finally { clearTimeout(timer); }
  } catch { return null; }
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`sar_owner_${Date.now()}`, PW);
  userToken = a.token!; userId = a.user!.user_id; NET = a.network_id!;
  for (let i = 0; i < ROWS; i++) seed(i);
  nodeToken = createNetworkTokenForNode(userId, NET, "sar-7", "node_sar_7").token!;
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("statusAliasResolverRead (signature)", () => {
  const p = (q: string) => new URLSearchParams(q);
  test("matches only node token + Accept exactly application/json + at most network_id", () => {
    expect(statusAliasResolverRead(p(""), "ntok_x", "application/json")).toBe(true);
    expect(statusAliasResolverRead(p("network_id=net_1"), "ntok_x", "application/json")).toBe(true);
    expect(statusAliasResolverRead(p("network_id=net_1"), "ntok_x", " Application/JSON ")).toBe(true);
    expect(statusAliasResolverRead(p("network_id=net_1"), "utok_x", "application/json")).toBe(false);
    expect(statusAliasResolverRead(p("network_id=net_1"), "legacy-global-token", "application/json")).toBe(false);
    expect(statusAliasResolverRead(p("network_id=net_1"), "ntok_x", null)).toBe(false);
    expect(statusAliasResolverRead(p("network_id=net_1"), "ntok_x", "*/*")).toBe(false);
    expect(statusAliasResolverRead(p("network_id=net_1"), "ntok_x", "application/json, text/plain, */*")).toBe(false);
    for (const q of ["light=1", "node_id=n", "alias=a", "full=1", "network_id=n&full=1", "network_id=n&light=0"]) {
      expect(statusAliasResolverRead(p(q), "ntok_x", "application/json")).toBe(false);
    }
  });
});

describe("GET /api/status for the old alias resolver", () => {
  test("old resolver still resolves its alias from the light body", async () => {
    expect(await oldResolver("node_sar_7", nodeToken, NET)).toBe("sar-7");
    expect(await oldResolver("node_sar_7", nodeToken, "")).toBe("sar-7");
    // other rows are resolvable too (the resolver can be asked about a renamed peer id) and an unknown id is null
    expect(await oldResolver("node_sar_42", nodeToken, NET)).toBe("sar-42");
    expect(await oldResolver("node_nobody", nodeToken, NET)).toBeNull();
  });

  test("…and follows a rename (the reason the resolver exists)", async () => {
    db.run("UPDATE sessions SET alias = 'sar-7-renamed' WHERE node_id = 'node_sar_7'");
    try {
      expect(await oldResolver("node_sar_7", nodeToken, NET)).toBe("sar-7-renamed");
    } finally {
      db.run("UPDATE sessions SET alias = 'sar-7' WHERE node_id = 'node_sar_7'");
    }
  });

  test("the body is the light projection plus node_id, marked by a header", async () => {
    const r = await req(`/api/status?network_id=${NET}`, asNode("application/json"));
    expect(r.status).toBe(200);
    expect(r.projection).toBe("alias-resolver");
    expect(r.body.sessions).toHaveLength(ROWS);
    expect(Object.keys(r.body.sessions[0]).sort()).toEqual(["agent", "alias", "network_id", "node_id", "runtime", "server", "status", "task", "updated_at"]);
    expect(r.body.summary.total).toBe(ROWS);
  });

  test("everything else is byte-identical to the full projection", async () => {
    const full = await req(`/api/status?network_id=${NET}&full=1`, asNode("application/json"));
    expect(full.projection).toBeNull();
    expect(full.body.sessions[0].host).toBeDefined();
    const same = [
      await req(`/api/status?network_id=${NET}`, { Authorization: `Bearer ${userToken}`, Accept: "application/json" }), // user token (app / dashboard)
      await req(`/api/status?network_id=${NET}`, asNode()),                                                          // anet CLI: authHeaders() only
      await req(`/api/status?network_id=${NET}`, asNode("*/*")),                                                     // browser / undici / bun default
      await req(`/api/status?network_id=${NET}`, asNode("application/json, text/plain, */*")),
    ];
    for (const r of same) {
      expect(r.projection).toBeNull();
      expect(r.body.sessions[0].host).toBeDefined();
      expect(r.text).toBe(full.text);
    }
  });

  test("light / node_id reads keep their own exact shape", async () => {
    const light = await req(`/api/status?network_id=${NET}&light=1`, asNode("application/json"));
    expect(light.projection).toBeNull();
    expect(light.body.sessions[0].node_id).toBeUndefined();
    const one = await req(`/api/status?network_id=${NET}&node_id=node_sar_7&light=1`, asNode("application/json"));
    expect(one.body.sessions).toHaveLength(1);
    expect(one.body.sessions[0].node_id).toBe("node_sar_7");
  });

  test("size: full projection vs the alias-resolver body (gzip)", async () => {
    const full = await req(`/api/status?network_id=${NET}&full=1`, asNode("application/json"));
    const slim = await req(`/api/status?network_id=${NET}`, asNode("application/json"));
    const f = gz(full.text), s = gz(slim.text);
    console.log(`[size] ${ROWS} rows: full ${full.text.length} B raw / ${f} B gzip → alias-resolver ${slim.text.length} B raw / ${s} B gzip (${Math.round(100 - (100 * s) / f)}% smaller)`);
    expect(s).toBeLessThan(f / 2);
  });
});
