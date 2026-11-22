// #4821 端到端（单进程）：真实 daemon bridge + 真实 Hub 存储 + 真实 HTTP 取页，
// 只把 MCP 传输换成直接调用同一批函数（MCP 层本身有单独的类型/绑定校验）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-4821-e2e-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");

let opencode: ReturnType<typeof Bun.serve>;
let hub: ReturnType<typeof Bun.serve>;
let base = "", ownerToken = "", net = "", nodeId = "e2e-node-1";
const password = "e2e-pass";

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= "legacy-master-token-for-test";
  // 假 OpenCode V2 server：只回 /api/session（原始页形状）
  opencode = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/api/session") return new Response(null, { status: 404 });
    return Response.json({
      data: [{
        id: "ses_e2e", title: "端到端会话", projectID: "proj_1",
        model: { id: "claude-sonnet-4", providerID: "anthropic", variant: "high" },
        time: { created: 1767225600000, updated: 1767225660000 },
        location: { directory: "/home/dev/work" },
      }],
      cursor: { previous: null, next: "cur_next" },
    });
  } });

  const { db } = await import("./db.js");
  const { register } = await import("./auth.js");
  const stamp = Date.now();
  const owner = register(`e2e_owner_${stamp}`, "E2e-Owner-1!");
  net = owner.network_id!; ownerToken = owner.token!;
  db.run(`INSERT OR REPLACE INTO nodes (node_id, node_name, network_id, alias, created_at, updated_at)
          VALUES (?1, 'e2e-node', ?2, 'e2e-node', ?3, ?3)`, [nodeId, net, Date.now()]);
  const mod = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
}, 60_000);

afterAll(() => { try { hub?.stop(true); } catch {}; try { opencode?.stop(true); } catch {}; try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("#4821 端到端：HTTP 请求 → daemon bridge 读真 server → Hub 投影 → 轮询拿到六字段", () => {
  test("一次完整往返，且第二次命中 60 秒缓存", async () => {
    const { db } = await import("./db.js");
    const store = await import("./opencode-session-requests.js");
    const { drainSessionRequests, makeSharedServerPageReader } = await import("../../agent-node/src/runtime/opencode-sessions-bridge.js");

    const r1 = await fetch(`${base}/api/nodes/${nodeId}/opencode-sessions?network_id=${net}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    const j1: any = await r1.json();
    expect(j1.pending).toBe(true);

    // daemon bridge：callCommHub 直接落到同一批 Hub 函数（MCP 只是传输层）
    const readPage = makeSharedServerPageReader({
      url: `http://127.0.0.1:${opencode.port}`,
      passwordFile: "/unused",
      readFile: () => password,
    })!;
    await drainSessionRequests({
      key: "e2e", warn: () => {},
      readPage,
      callCommHub: async (name: string, args: any) => {
        if (name === "pull_session_requests") return { ok: true, requests: store.takePendingForDaemon(db, nodeId, 5).map(r => ({ request_id: r.request_id, cursor: r.cursor, limit: r.limit_n })) };
        if (name === "ack_session_request") return store.ackSessionRequest(db, { requestId: args.request_id, ok: args.ok, resultJson: args.data_json ?? null, error: args.error ?? null });
        return { ok: false, error: "unexpected" };
      },
    });

    const r2 = await fetch(`${base}/api/session-requests/${j1.request_id}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    const j2: any = await r2.json();
    expect(j2.status).toBe("succeeded");
    expect(j2.data).toHaveLength(1);
    expect(j2.data[0]).toMatchObject({
      id: "ses_e2e", title: "端到端会话", project_id: "proj_1", directory: "/home/dev/work",
      updated_at: "2026-01-01T00:01:00Z",             // epoch ms → ISO-8601 UTC
      model: { provider: "anthropic", id: "claude-sonnet-4", variant: "high" },
    });
    expect(j2.next_cursor).toBe("cur_next");

    const r3 = await fetch(`${base}/api/nodes/${nodeId}/opencode-sessions?network_id=${net}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    const j3: any = await r3.json();
    expect(j3.cached).toBe(true);
    expect(j3.data[0].id).toBe("ses_e2e");
  });
});
