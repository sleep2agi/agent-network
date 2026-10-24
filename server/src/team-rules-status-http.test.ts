// #2211 — the wired half: what the node reports must reach `/api/status` as one word.
//
// The pure derivation has its own tests (team-rules-status.test.ts). This file checks the
// three seams that can still be wrong after that module is correct:
//   1. the session row actually carries the reported columns (db.ts migration + tools.ts persist);
//   2. the projection compares against the *network's* current revision (not a global one);
//   3. a session that never reported stays byte-identical (no `team_rules` key at all).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import "./require-explicit-test-db.js";
import { register } from "./auth.js";
import { db } from "./db.js";
import { ensureNetworkRules } from "./network-rules.js";

let BASE = "";
let server: any = null;
let token = "";
let netId = "";

async function getStatus(query = "") {
  const res = await fetch(`${BASE}/api/status${query}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return await res.json();
}

function seedSession(resumeId: string, alias: string, cols: Record<string, unknown> = {}) {
  const keys = ["resume_id", "alias", "network_id", ...Object.keys(cols)];
  const values = [resumeId, alias, netId, ...Object.values(cols)];
  db.run(
    `INSERT INTO sessions (${keys.join(",")}) VALUES (${keys.map((_, i) => `?${i + 1}`).join(",")})`,
    values,
  );
}

beforeAll(async () => {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const a = register(`trs_${suffix}`, "TrsPw123Aa!", undefined, "trs");
  expect(a.ok).toBe(true);
  token = a.token!;
  netId = a.network_id!;
  const { bootServer } = await import("./server.js");
  server = bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(() => { try { server?.stop?.(true); } catch {} });

describe("#2211 — team rules state in /api/status", () => {
  test("a session that never reported has no team_rules key", async () => {
    seedSession(`never-${Date.now()}`, `never-${Date.now()}`);
    const body = await getStatus();
    const row = body.sessions.find((s: any) => s.alias.startsWith("never-"));
    expect(row).toBeTruthy();
    expect("team_rules" in row).toBe(false);
  });

  test("reported revision behind the network's → outdated; equal → current", async () => {
    ensureNetworkRules(db);   // created lazily by the rules API; this test seeds it directly
    const rev = Number((db.get<{ revision: number }>("SELECT revision FROM network_rules WHERE network_id = ?1", netId)?.revision) ?? 0) + 2;
    db.run(
      "INSERT INTO network_rules (network_id, content, revision, updated_at, updated_by_json) VALUES (?1, 'rules', ?2, datetime('now'), NULL) ON CONFLICT(network_id) DO UPDATE SET revision = ?2",
      [netId, rev],
    );
    seedSession(`behind-${Date.now()}`, `behind-${Date.now()}`, { team_rules_revision: rev - 1, team_rules_status: "unchanged" });
    seedSession(`equal-${Date.now()}`, `equal-${Date.now()}`, { team_rules_revision: rev, team_rules_status: "injected" });
    const body = await getStatus();
    const behind = body.sessions.find((s: any) => s.alias.startsWith("behind-"));
    const equal = body.sessions.find((s: any) => s.alias.startsWith("equal-"));
    expect(behind.team_rules.state).toBe("outdated");
    expect(behind.team_rules.applied_revision).toBe(rev - 1);
    expect(behind.team_rules.current_revision).toBe(rev);
    expect(equal.team_rules.state).toBe("current");
  });

  test("an error report is failed, with its reason", async () => {
    seedSession(`errored-${Date.now()}`, `errored-${Date.now()}`, {
      team_rules_status: "error", team_rules_reason: "expected exactly one BEGIN",
    });
    const body = await getStatus();
    const row = body.sessions.find((s: any) => s.alias.startsWith("errored-"));
    expect(row.team_rules.state).toBe("failed");
    expect(row.team_rules.reason).toBe("expected exactly one BEGIN");
  });

  test("the light projection keeps its exact shape (no team_rules, no extra bytes)", async () => {
    const res = await fetch(`${BASE}/api/status?light=1`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const row of body.sessions) expect("team_rules" in row).toBe(false);
  });
});
