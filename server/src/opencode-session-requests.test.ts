// #4821 Hub 侧请求通道：TTL 复用、并发去重、ack 幂等、越权边界。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-ssr-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");

describe("#4821 opencode-session-requests", () => {
  test("建请求 → 同 node+cursor 复用 pending，不产生第二行", async () => {
    const { db } = await import("./db.js");
    const m = await import("./opencode-session-requests.js");
    m.ensureSessionRequestsTable(db);
    const a = m.createSessionRequest(db, { networkId: "n1", nodeId: "d1", cursor: null, limit: 50, createdBy: "u1" });
    const b = m.findOpenRequest(db, "n1", "d1", null);
    expect(b?.request_id).toBe(a.request_id);
    // 不同 cursor 是另一条
    const c = m.findOpenRequest(db, "n1", "d1", "cur2");
    expect(c).toBeNull();
  });

  test("daemon 拉走后 status=delivered；ack 成功后 60 秒内命中缓存，超时不命中", async () => {
    const { db } = await import("./db.js");
    const m = await import("./opencode-session-requests.js");
    m.ensureSessionRequestsTable(db);
    const req = m.createSessionRequest(db, { networkId: "n2", nodeId: "d2", cursor: "c1", limit: 10, createdBy: "u1" });
    const pulled = m.takePendingForDaemon(db, "d2");
    expect(pulled.map(r => r.request_id)).toContain(req.request_id);
    expect(m.getSessionRequest(db, req.request_id)?.status).toBe("delivered");
    // 再拉一次拿不到（已经 delivered）
    expect(m.takePendingForDaemon(db, "d2").map(r => r.request_id)).not.toContain(req.request_id);
    const payload = JSON.stringify({ data: [{ id: "ses_1", title: "t", project_id: null, model: null, updated_at: "2026-01-01T00:00:00Z", directory: "/x" }], cursor: { previous: null, next: "n2" } });
    expect(m.ackSessionRequest(db, { requestId: req.request_id, ok: true, resultJson: payload })).toEqual({ ok: true });
    expect(m.findFreshResult(db, "n2", "d2", "c1")?.request_id).toBe(req.request_id);
    const later = Date.now() + m.SESSION_REQUEST_TTL_MS + 1;
    expect(m.findFreshResult(db, "n2", "d2", "c1", later)).toBeNull();
  });

  test("🔴 ack 失败语义：ok=true 没有结果体要拒；非投递态不重复写；ack 幂等", async () => {
    const { db } = await import("./db.js");
    const m = await import("./opencode-session-requests.js");
    m.ensureSessionRequestsTable(db);
    const req = m.createSessionRequest(db, { networkId: "n3", nodeId: "d3", cursor: null, limit: 10, createdBy: "u1" });
    expect(m.ackSessionRequest(db, { requestId: req.request_id, ok: true })).toEqual({ ok: false, error: "result_required" });
    m.takePendingForDaemon(db, "d3");
    expect(m.ackSessionRequest(db, { requestId: req.request_id, ok: false, error: "opencode_unreachable" })).toEqual({ ok: true });
    expect(m.getSessionRequest(db, req.request_id)?.status).toBe("failed");
    expect(m.getSessionRequest(db, req.request_id)?.error).toBe("opencode_unreachable");
    // 幂等：再 ack 一次不报错、不改状态
    expect(m.ackSessionRequest(db, { requestId: req.request_id, ok: true, resultJson: "{}" })).toEqual({ ok: true });
    expect(m.getSessionRequest(db, req.request_id)?.status).toBe("failed");
    expect(m.ackSessionRequest(db, { requestId: "ssr_missing", ok: true, resultJson: "{}" })).toEqual({ ok: false, error: "request_not_found" });
  });

  test("只清理 24 小时以前的行（近期行留着排障）", async () => {
    const { db } = await import("./db.js");
    const m = await import("./opencode-session-requests.js");
    m.ensureSessionRequestsTable(db);
    const req = m.createSessionRequest(db, { networkId: "n4", nodeId: "d4", cursor: null, limit: 10, createdBy: "u1" });
    expect(m.purgeStaleSessionRequests(db)).toBe(0);
    expect(m.purgeStaleSessionRequests(db, Date.now() + 25 * 60 * 60_000)).toBeGreaterThanOrEqual(1);
    expect(m.getSessionRequest(db, req.request_id)).toBeNull();
  });
});
