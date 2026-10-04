// #550 — the sticky session capability flags (rules_file_capable / skills_capable /
// files_capable / logs_capable) survive a session handover.
//
// report_status for an alias that already has a row under ANOTHER resume_id takes
// the DELETE + INSERT handover path. That path carried registered_at and the
// descriptive columns, but not the capability flags, so the new row started at
// the column default 0 — although the flags are meant to be sticky (only ever set
// to 1). Board #548: the 通信龙 node's MCP channel reconnected under a new
// resume_id and the rules-file / skills / files / logs doorbells went dark.
//
// Pinned through the real HTTP entrance (POST /mcp with the node's own token):
//   1. flags set on resume A are still 1 after the same alias reports resume B
//      without them — and after it switches back to A.
//   2. only flags that were 1 are carried; a 0 is never promoted.
//   3. a later report omitting the flags on the same resume_id still keeps them.
//   4. a user token cannot report for the alias, so it cannot hand the flags to a
//      session of its own.
//
// 跑法:cd server && COMMHUB_DB=/tmp/x.db bun test src/report-status-handover-capabilities-http.test.ts
//       PG:COMMHUB_TEST_PG_URL=… COMMHUB_PG_EXPERIMENTAL=1(tests/test2123-hub-postgres-ladder 里注册)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";

const dir = mkdtempSync(join(tmpdir(), "anet-handover-caps-"));
const activeDbPath = process.env.COMMHUB_DB ?? (process.env.COMMHUB_TEST_PG_URL ? "postgres" : undefined);
if (!activeDbPath) throw new Error("report-status-handover-capabilities requires COMMHUB_DB (or COMMHUB_TEST_PG_URL) before module import");

const stamp = Date.now();
let server: any;
let base = "";
let ownerToken = "", ownerId = "", NET = "";
type Node = { alias: string; nodeId: string; token: string };
const nodes: Record<string, Node> = {};

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const data = raw.split("\n").filter((x) => x.startsWith("data:"));
  const payload = data.length ? JSON.parse(data.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  const text = payload.result.content[0].text;
  if (!text.startsWith("{")) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

// resume_id is the sessions primary key — every alias below uses its own (cc-*-<nodeId>).
const ALL_FLAGS = { rules_file_capable: true, skills_capable: true, files_capable: true, logs_capable: true };
const report = (token: string, n: Node, resume: string, extra: Record<string, unknown> = {}) =>
  tool(token, "report_status", { resume_id: resume, alias: n.alias, status: "idle", agent: "claude-code", network_id: NET, ...extra });

type CapRow = { resume_id: string; rules_file_capable: number; skills_capable: number; files_capable: number; logs_capable: number };
const capRows = (alias: string) =>
  db.all<CapRow>(
    "SELECT resume_id, rules_file_capable, skills_capable, files_capable, logs_capable FROM sessions WHERE alias = ?1 AND network_id = ?2",
    alias, NET,
  ).map((r) => ({
    resume_id: r.resume_id,
    rules_file_capable: Number(r.rules_file_capable), skills_capable: Number(r.skills_capable),
    files_capable: Number(r.files_capable), logs_capable: Number(r.logs_capable),
  }));

beforeAll(async () => {
  process.env.COMMHUB_UPLOADS_DIR = join(dir, "uploads");
  process.env.HOST = "127.0.0.1";
  const owner = register(`hcap_owner_${stamp}`, "HandoverCaps123!", undefined, "seed");
  ownerToken = owner.token!; ownerId = owner.user!.user_id; NET = owner.network_id!;
  for (const key of ["all", "some", "user"]) {
    const alias = `hcap-${key}-${stamp}`;
    const nodeId = `n_hcap_${key}_${stamp}`;
    const minted = createNetworkTokenForNode(ownerId, NET, alias, nodeId);
    expect(minted.ok).toBe(true);
    nodes[key] = { alias, nodeId, token: minted.token! };
  }
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("#550 sticky capability flags survive a resume_id handover", () => {
  test("all four flags carry to the new resume_id, and back again", async () => {
    const n = nodes.all!;
    expect((await report(n.token, n, `cc-a-${n.nodeId}`, ALL_FLAGS)).ok).toBe(true);
    expect(capRows(n.alias)).toEqual([{ resume_id: `cc-a-${n.nodeId}`, rules_file_capable: 1, skills_capable: 1, files_capable: 1, logs_capable: 1 }]);

    // The channel reconnects under a new resume_id and reports WITHOUT the flags.
    expect((await report(n.token, n, `cc-b-${n.nodeId}`)).ok).toBe(true);
    expect(capRows(n.alias)).toEqual([{ resume_id: `cc-b-${n.nodeId}`, rules_file_capable: 1, skills_capable: 1, files_capable: 1, logs_capable: 1 }]);

    // Same resume_id, flags omitted again (status-only report) — still sticky.
    expect((await report(n.token, n, `cc-b-${n.nodeId}`)).ok).toBe(true);
    expect(capRows(n.alias)[0]).toMatchObject({ rules_file_capable: 1, skills_capable: 1, files_capable: 1, logs_capable: 1 });

    // Two reporters taking turns (agent-node + TUI MCP): switching back keeps them too.
    expect((await report(n.token, n, `cc-a-${n.nodeId}`)).ok).toBe(true);
    expect(capRows(n.alias)).toEqual([{ resume_id: `cc-a-${n.nodeId}`, rules_file_capable: 1, skills_capable: 1, files_capable: 1, logs_capable: 1 }]);
  }, 20_000);

  test("only flags that were 1 are carried — a 0 is never promoted", async () => {
    const n = nodes.some!;
    expect((await report(n.token, n, `cc-a-${n.nodeId}`, { rules_file_capable: true, logs_capable: true })).ok).toBe(true);
    expect((await report(n.token, n, `cc-b-${n.nodeId}`)).ok).toBe(true);
    expect(capRows(n.alias)).toEqual([{ resume_id: `cc-b-${n.nodeId}`, rules_file_capable: 1, skills_capable: 0, files_capable: 0, logs_capable: 1 }]);
  }, 20_000);

  test("a user token cannot report for the alias, so it cannot take over the flags", async () => {
    const n = nodes.user!;
    expect((await report(n.token, n, `cc-a-${n.nodeId}`, ALL_FLAGS)).ok).toBe(true);
    const r = await report(ownerToken, n, `cc-hijack-${n.nodeId}`);
    expect(r.ok).toBe(false);
    expect(capRows(n.alias)).toEqual([{ resume_id: `cc-a-${n.nodeId}`, rules_file_capable: 1, skills_capable: 1, files_capable: 1, logs_capable: 1 }]);
  }, 20_000);
});
