// Node display attributes — team / tags / display_name (Vincent 目标第 3 条).
//
// These are HUB-SIDE DISPLAY attributes. Following the `avatar_url` (#462)
// precedent they are deliberately NOT part of the RFC-024 config-apply
// pipeline: agent-node has nothing to consume, so pushing them through
// config revision/ack would ring a doorbell for a field the node does not
// understand and could wedge the config revision.
//
// They DO need concurrency protection (two dashboards editing the same
// node), which `avatar_url` lacks. Hence a dedicated `attrs_revision` CAS
// that is independent of `config_revision` — editing a tag must never bump
// the node's *config* revision.
//
// Every test drives the REAL HTTP endpoint against a booted server, not a
// helper: the contract under test is the wire shape + status codes.
//
// NOTE (test isolation): this file boots its own Bun.serve, same pattern as
// uploads-http.test.ts / api-host-supervisors-fallback.test.ts. Those files
// are per-file runs by design (single-process module-singleton conflict,
// tracked in #434) — run this file on its own.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpDb = join(mkdtempSync(join(tmpdir(), "anet-attrs-")), "commhub.db");
process.env.COMMHUB_DB = tmpDb;
const PORT = 23000 + Math.floor(Math.random() * 1500);
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";

const { db } = await import("./db.js");
const { issueUserToken } = await import("./auth.js");
const { bootServer } = await import("./server.js");

const BASE = `http://127.0.0.1:${PORT}`;
const NET = "net_attrs";
const USER = "u_attrs";
/** A node row seeded the way a PRE-MIGRATION row looks: none of the new
 *  columns are written, so they are NULL / default at read time. */
const LEGACY_NODE = "node_attrs_legacy";
const LEGACY_ALIAS = "attrs-legacy-node";

let token = "";
let server: { stop: (force?: boolean) => void } | null = null;

beforeAll(async () => {
  db.run(`INSERT INTO users (user_id, username, password_hash, role) VALUES (?1, 'attrs-user', 'x', 'user')`, [USER]);
  db.run(`INSERT INTO networks (network_id, network_name, owner_id) VALUES (?1, 'attrs-net', ?2)`, [NET, USER]);
  db.run(`INSERT INTO network_members (network_id, user_id, role) VALUES (?1, ?2, 'owner')`, [NET, USER]);
  // Legacy row: only the columns that existed before this change.
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, runtime, model, network_id)
     VALUES (?1, 'attrs-legacy', ?2, 'claude-agent-sdk', 'claude-sonnet-4-6', ?3)`,
    [LEGACY_NODE, LEGACY_ALIAS, NET],
  );
  token = issueUserToken(USER, "attrs-test").token;
  server = bootServer({ port: PORT, hostname: "127.0.0.1" }) as never;
  await new Promise((r) => setTimeout(r, 120));
});

afterAll(() => {
  try { server?.stop(true); } catch { /* already down */ }
});

async function putAttrs(ref: string, body: unknown) {
  const res = await fetch(`${BASE}/api/nodes/${encodeURIComponent(ref)}/attrs?network_id=${NET}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function listNodes() {
  const res = await fetch(`${BASE}/api/nodes?network_id=${NET}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = (await res.json()) as { nodes?: Array<Record<string, unknown>> };
  return j.nodes ?? [];
}

describe("node display attrs — backward compatibility with existing rows", () => {
  test("a pre-migration node row still lists fine; new fields read as empty, not missing/throwing", async () => {
    const rows = await listNodes();
    const row = rows.find((r) => r.node_id === LEGACY_NODE);
    expect(row).toBeDefined();
    // Must not blow up and must not omit the keys — the dashboard reads
    // them unconditionally.
    expect(row!).toHaveProperty("display_name");
    expect(row!).toHaveProperty("team");
    expect(row!).toHaveProperty("tags");
    expect(row!.display_name ?? null).toBeNull();
    expect(row!.team ?? null).toBeNull();
    // tags normalises to an empty array rather than null/undefined so the
    // dashboard can `.map()` without a guard.
    expect(row!.tags).toEqual([]);
    expect(row!.attrs_revision).toBe(0);
  });
});

describe("node display attrs — write then read back", () => {
  test("PUT sets display_name/team/tags, bumps attrs_revision, and GET /api/nodes reflects it", async () => {
    const w = await putAttrs(LEGACY_ALIAS, {
      base_attrs_revision: 0,
      display_name: "研发一号机",
      team: "platform",
      tags: ["prod", "gpu"],
    });
    expect(w.status).toBe(200);
    expect(w.json.ok).toBe(true);
    expect(w.json.attrs_revision).toBe(1);

    const row = (await listNodes()).find((r) => r.node_id === LEGACY_NODE)!;
    expect(row.display_name).toBe("研发一号机");
    expect(row.team).toBe("platform");
    expect(row.tags).toEqual(["prod", "gpu"]);
    expect(row.attrs_revision).toBe(1);
  });

  test("editing attrs does NOT touch config_revision (display vs config are separate revisions)", async () => {
    const before = db.get<{ config_revision: number }>(
      "SELECT config_revision FROM nodes WHERE node_id = ?1", LEGACY_NODE)!.config_revision ?? 0;
    const w = await putAttrs(LEGACY_ALIAS, { base_attrs_revision: 1, team: "infra" });
    expect(w.status).toBe(200);
    const after = db.get<{ config_revision: number }>(
      "SELECT config_revision FROM nodes WHERE node_id = ?1", LEGACY_NODE)!.config_revision ?? 0;
    expect(after).toBe(before);
  });

  test("partial patch leaves untouched fields alone", async () => {
    const row = (await listNodes()).find((r) => r.node_id === LEGACY_NODE)!;
    // team was just changed to 'infra'; display_name/tags must survive.
    expect(row.team).toBe("infra");
    expect(row.display_name).toBe("研发一号机");
    expect(row.tags).toEqual(["prod", "gpu"]);
  });
});

describe("node display attrs — CAS concurrency guard", () => {
  test("stale base_attrs_revision → 409 with the current revision, and NO write happens", async () => {
    const before = (await listNodes()).find((r) => r.node_id === LEGACY_NODE)!;
    const stale = await putAttrs(LEGACY_ALIAS, {
      base_attrs_revision: 0, // deliberately stale
      team: "should-not-land",
    });
    expect(stale.status).toBe(409);
    expect(stale.json.ok).toBe(false);
    expect(stale.json.error).toBe("attrs_revision_conflict");
    expect(stale.json.current_attrs_revision).toBe(before.attrs_revision);

    const after = (await listNodes()).find((r) => r.node_id === LEGACY_NODE)!;
    expect(after.team).toBe(before.team); // unchanged
    expect(after.attrs_revision).toBe(before.attrs_revision);
  });
});

describe("node display attrs — untrusted input is narrowed at the boundary", () => {
  test("tags: non-strings dropped, blanks dropped, duplicates folded, count + length capped", async () => {
    const cur = (await listNodes()).find((r) => r.node_id === LEGACY_NODE)!.attrs_revision as number;
    const w = await putAttrs(LEGACY_ALIAS, {
      base_attrs_revision: cur,
      tags: [
        "keep",
        "keep", // duplicate
        "  spaced  ", // trimmed
        "",
        "   ",
        42,
        null,
        { evil: true },
        ["nested"],
        "x".repeat(200), // over-long → dropped or truncated, never stored raw
      ],
    });
    expect(w.status).toBe(200);
    const tags = (await listNodes()).find((r) => r.node_id === LEGACY_NODE)!.tags as string[];
    expect(Array.isArray(tags)).toBe(true);
    expect(tags).toContain("keep");
    expect(tags).toContain("spaced");
    // one "keep", no junk, nothing absurdly long
    expect(tags.filter((t) => t === "keep")).toHaveLength(1);
    expect(tags.every((t) => typeof t === "string" && t.length > 0 && t.length <= 64)).toBe(true);
    expect(tags.some((t) => t.includes("evil") || t.includes("nested"))).toBe(false);
  });

  test("display_name/team: non-string values are rejected, not coerced", async () => {
    const cur = (await listNodes()).find((r) => r.node_id === LEGACY_NODE)!.attrs_revision as number;
    const bad = await putAttrs(LEGACY_ALIAS, { base_attrs_revision: cur, team: { not: "a string" } });
    expect(bad.status).toBe(400);
    expect(bad.json.ok).toBe(false);
  });
});

describe("node display attrs — auth + scope", () => {
  test("no token → 401, and the row is untouched", async () => {
    const before = (await listNodes()).find((r) => r.node_id === LEGACY_NODE)!;
    const res = await fetch(`${BASE}/api/nodes/${LEGACY_ALIAS}/attrs?network_id=${NET}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_attrs_revision: before.attrs_revision, team: "hijack" }),
    });
    expect(res.status).toBe(401);
    const after = (await listNodes()).find((r) => r.node_id === LEGACY_NODE)!;
    expect(after.team).toBe(before.team);
  });

  test("unknown node ref → 404", async () => {
    const r = await putAttrs("no-such-node-ref", { base_attrs_revision: 0, team: "x" });
    expect(r.status).toBe(404);
  });
});
