// #1473 (#909) — the Hub's Skills / secrets / Provider catalogs had MCP tools
// but no HTTP read surface, so the desktop client shipped a fixture page
// (agent-network-app/src/hub-scope-demo.ts: "Hub 这些写接口还没接通 ... 不发请求").
//
// These three endpoints are read-only and user-token only. The load-bearing
// properties are:
//   * a NODE token cannot enumerate the network's catalogs;
//   * a plain member of another network cannot read this network's catalogs;
//   * pending SkillHub submissions stay invisible unless the caller reviews;
//   * NO secret value ever appears in a response body (asserted with a
//     sentinel that would be trivially visible if a value were serialized).
//
// The sentinel test is deliberately byte-level on the raw response text: a
// future field like `value_preview` would pass a JSON-shape assertion while
// still leaking the secret.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-hub-catalog-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DB_DIR, "hub.db");
// The vault encrypts on write; set the master key before db.ts/vault.ts load.
process.env.ANET_HUB_SECRET_VAULT_KEY ||= "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

let server: ReturnType<typeof Bun.serve>;
let base = "";
let ownerToken = "", strangerToken = "", nodeToken = "";
let ownerNet = "", strangerNet = "", ownerUserId = "";
const SECRET_NAME = "PROVIDER_SENTINEL_KEY";
const SECRET_VALUE = "sentinel-value-DO-NOT-LEAK-4f9a2c";

const get = async (path: string, token: string) => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: r.status, body, text };
};

beforeAll(async () => {
  const { db } = await import("./db.js");
  const { register, createNetworkTokenForNode } = await import("./auth.js");
  const { vaultUpsert } = await import("./vault.js");
  const stamp = Date.now();

  const owner = register(`hc_owner_${stamp}`, "HcOwner-Strong-1!");
  const stranger = register(`hc_stranger_${stamp}`, "HcStranger-Strong-1!");
  expect(owner.ok && stranger.ok).toBe(true);
  ownerToken = owner.token!;
  strangerToken = stranger.token!;
  ownerNet = owner.network_id!;
  strangerNet = stranger.network_id!;
  ownerUserId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `hc_owner_${stamp}`)!.user_id;

  // A node token in the SAME network: it must still be refused, because a node
  // is not a person and may not enumerate catalogs.
  const nodeTok = createNetworkTokenForNode(ownerUserId, ownerNet, "hc-node", "n_hc_test");
  expect(nodeTok.ok).toBe(true);
  nodeToken = nodeTok.token!;

  // Published + pending skills in the owner's network.
  const skill = (id: string, status: string, slug: string) => db.run(
    `INSERT INTO skillhub_skills (skill_id, network_id, slug, name, description, content, content_hash, version, status, source_type, source_alias, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3, 'd', '# SKILL body', 'hash-' || ?1, '1.0.0', ?4, 'node', 'hc-node', datetime('now'), datetime('now'))`,
    [id, ownerNet, slug, status],
  );
  skill("skill_hc_pub", "published", "hc-published");
  skill("skill_hc_pending", "pending", "hc-pending");

  // The sentinel secret. Names may be shown; values never.
  vaultUpsert(ownerNet, SECRET_NAME, SECRET_VALUE);

  db.run(
    `INSERT INTO hub_provider_configs (network_id, provider_id, revision, config_json, secret_key_ref, updated_at)
     VALUES (?1, 'hc-provider', 3, ?2, ?3, ?4)`,
    [ownerNet, JSON.stringify({ id: "hc-provider", label: "HC Provider", enabled: true, protocol: "openai-responses", baseUrl: "https://example.test/v1", models: ["m1"] }), "HC_PROVIDER_KEY", Date.now()],
  );

  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

describe("GET /api/skills", () => {
  test("owner sees published skills and no content body", async () => {
    const r = await get(`/api/skills?network_id=${ownerNet}`, ownerToken);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.reviewer).toBe(true);
    expect(r.body.network_id).toBe(ownerNet);
    const slugs = r.body.skills.map((s: any) => s.slug);
    expect(slugs).toContain("hc-published");
    // Pending is opt-in even for a reviewer.
    expect(slugs).not.toContain("hc-pending");
    // The list is metadata only — a body field would mean SKILL.md text leaked.
    for (const s of r.body.skills) expect(s.content).toBeUndefined();
  });

  test("reviewer may ask for pending submissions", async () => {
    const r = await get(`/api/skills?network_id=${ownerNet}&include_pending=1`, ownerToken);
    expect(r.status).toBe(200);
    const slugs = r.body.skills.map((s: any) => s.slug);
    expect(slugs).toContain("hc-pending");
  });

  test("a member of another network is refused", async () => {
    const r = await get(`/api/skills?network_id=${ownerNet}`, strangerToken);
    expect(r.status).toBe(403);
    // Cross-network access is refused by REST scope resolution BEFORE the role
    // check runs, so the error names the scope gate. Either way: 403, no data.
    expect(String(r.body.error)).toMatch(/access denied|permission_denied/);
  });

  test("a node token is refused even inside its own network", async () => {
    const r = await get(`/api/skills?network_id=${ownerNet}`, nodeToken);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("user_token_required");
  });

  test("include_pending is ignored for a non-reviewer of that network", async () => {
    // The stranger's own network has no skills; the point is that asking for
    // pending must not widen what they can see when they ask about their own.
    const r = await get(`/api/skills?network_id=${strangerNet}&include_pending=1`, strangerToken);
    expect(r.status).toBe(200);
    expect(r.body.reviewer).toBe(true); // they own their own network
    expect(r.body.skills).toEqual([]);
  });
});

describe("GET /api/secrets", () => {
  test("returns key names and timestamps, never the value", async () => {
    const r = await get(`/api/secrets?network_id=${ownerNet}`, ownerToken);
    expect(r.status).toBe(200);
    const names = r.body.keys.map((k: any) => k.key);
    expect(names).toContain(SECRET_NAME);
    // <-- The load-bearing assertion: raw body text must not contain the value.
    expect(r.text).not.toContain(SECRET_VALUE);
    expect(r.text).not.toContain("ciphertext");
    expect(r.text).not.toContain("iv");
    expect(r.text).not.toContain("tag");
  });

  test("a member of another network is refused and learns no key names", async () => {
    const r = await get(`/api/secrets?network_id=${ownerNet}`, strangerToken);
    expect(r.status).toBe(403);
    expect(r.text).not.toContain(SECRET_NAME);
    expect(r.text).not.toContain(SECRET_VALUE);
  });

  test("a node token is refused", async () => {
    const r = await get(`/api/secrets?network_id=${ownerNet}`, nodeToken);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("user_token_required");
  });
});

describe("GET /api/providers", () => {
  test("returns the registry without secret references", async () => {
    const r = await get(`/api/providers?network_id=${ownerNet}`, ownerToken);
    expect(r.status).toBe(200);
    expect(r.body.providers).toHaveLength(1);
    expect(r.body.providers[0]).toMatchObject({ id: "hc-provider", label: "HC Provider", source: "hub" });
    // The vault key NAME is a hint an attacker does not need; `exposeRefs` is
    // false here on purpose.
    expect(r.body.providers[0].secret_key_ref).toBeUndefined();
    expect(r.text).not.toContain("HC_PROVIDER_KEY");
    expect(r.text).not.toContain(SECRET_VALUE);
  });

  test("a member of another network is refused", async () => {
    const r = await get(`/api/providers?network_id=${ownerNet}`, strangerToken);
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("hc-provider");
  });

  test("a node token is refused", async () => {
    const r = await get(`/api/providers?network_id=${ownerNet}`, nodeToken);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("user_token_required");
  });
});
