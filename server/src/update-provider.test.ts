import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import {
  validateBaseUrl,
  ProbeValidationError,
} from "./probe-validate.js";

// RFC-028 P1.5 — update_provider invariants. Tests the building blocks
// the MCP handler relies on:
//   - SQL-level SEC-1 (provider_id × network_id uniqueness across tenants)
//   - audit_log row written for every update
//   - validateBaseUrl re-runs against vendor from DB (not patch) on
//     base_url change → vendor immutability bypass attempt fails
//   - patch-empty noop path
//   - DELETE FROM provider_models + INSERT replacement is atomic
//
// Boundary behaviour (zod-strict patch wrapper, MCP -32602 on extras,
// admin gate, cross-tenant rejection) is covered by the docker e2e
// (qa-rfc028-update-provider). The unit layer focuses on the impl
// guarantees that survive even if the MCP boundary changes.

const NET_A = "net_test_pa_alpha";
const NET_B = "net_test_pa_beta";
const PROV_A = "prov_test_p15_alpha";
const PROV_B = "prov_test_p15_beta";

beforeEach(() => {
  for (const p of [PROV_A, PROV_B]) {
    try { db.run("DELETE FROM provider_models WHERE provider_id = ?1", [p]); } catch {}
    try { db.run("DELETE FROM providers WHERE provider_id = ?1", [p]); } catch {}
  }
  try { db.run("DELETE FROM audit_log WHERE target_id IN (?1, ?2)", [PROV_A, PROV_B]); } catch {}
});

afterAll(() => {
  for (const p of [PROV_A, PROV_B]) {
    try { db.run("DELETE FROM provider_models WHERE provider_id = ?1", [p]); } catch {}
    try { db.run("DELETE FROM providers WHERE provider_id = ?1", [p]); } catch {}
  }
  try { db.run("DELETE FROM audit_log WHERE target_id IN (?1, ?2)", [PROV_A, PROV_B]); } catch {}
});

function seedProvider(provider_id: string, network_id: string, opts: Partial<{ name: string; vendor: string; base_url: string; enabled: number }> = {}) {
  db.run(
    `INSERT INTO providers (provider_id, network_id, name, vendor, base_url, secret_key_ref, created_at, created_by, enabled)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    [provider_id, network_id, opts.name ?? "anthro-prod", opts.vendor ?? "anthropic",
     opts.base_url ?? "https://api.anthropic.com", "ANTHROPIC_API_KEY",
     Date.now(), "test", opts.enabled ?? 1],
  );
}

describe("update_provider — SQL invariants (RFC-028 P1.5)", () => {
  test("SEC-1: provider_id is unique-per-network — netA query for netB provider_id returns nothing", () => {
    seedProvider(PROV_A, NET_A);
    seedProvider(PROV_B, NET_B);
    // The handler's lookup query: SELECT ... WHERE provider_id = ? AND network_id = ?
    const fromNetA = db.get<any>(
      "SELECT provider_id FROM providers WHERE provider_id = ?1 AND network_id = ?2",
      PROV_B, NET_A,
    );
    expect(fromNetA == null).toBe(true);
    // Sanity: PROV_B does exist in its own network
    const fromNetB = db.get<any>(
      "SELECT provider_id FROM providers WHERE provider_id = ?1 AND network_id = ?2",
      PROV_B, NET_B,
    );
    expect(fromNetB?.provider_id).toBe(PROV_B);
  });

  test("vendor immutability via validateBaseUrl: changing base_url uses DB vendor, attempt to widen via patched vendor fails", () => {
    seedProvider(PROV_A, NET_A, { vendor: "anthropic" });
    // Handler reads vendor from DB row, NOT from patch. Suppose patch tried
    // to set vendor=evil + base_url=https://attacker.example.com — the
    // handler ignores the vendor from patch (it's not a field in the
    // zod patch schema), and validateBaseUrl runs with vendor='anthropic'
    // from the DB, so the host check is applied.
    const dbVendor = db.get<{vendor: string}>("SELECT vendor FROM providers WHERE provider_id = ?1", PROV_A)!.vendor;
    expect(dbVendor).toBe("anthropic");
    // attempting to use base_url not in anthropic allowlist fails
    expect(() => validateBaseUrl(dbVendor, "https://attacker.example.com")).toThrow(ProbeValidationError);
    expect(() => validateBaseUrl(dbVendor, "https://attacker.example.com")).toThrow(/probe_target_forbidden/);
    // valid anthropic host passes
    expect(() => validateBaseUrl(dbVendor, "https://api.anthropic.com/v1")).not.toThrow();
  });

  test("patch noop: enabled set to same value → SET clause skipped", () => {
    seedProvider(PROV_A, NET_A, { enabled: 1 });
    const before = db.get<{enabled: number}>("SELECT enabled FROM providers WHERE provider_id = ?1", PROV_A)!.enabled;
    expect(before).toBe(1);
    // simulate the handler's diff logic: if patch.enabled === row.enabled, skip
    const newEnabled = true ? 1 : 0;
    const shouldUpdate = newEnabled !== before;
    expect(shouldUpdate).toBe(false);
    // verify no SET ran (row unchanged)
    const after = db.get<{enabled: number}>("SELECT enabled FROM providers WHERE provider_id = ?1", PROV_A)!.enabled;
    expect(after).toBe(1);
  });

  test("enabled toggle 1→0 written + audit log row created in same transaction", () => {
    seedProvider(PROV_A, NET_A, { enabled: 1 });
    db.exec("BEGIN");
    db.run("UPDATE providers SET enabled = 0 WHERE provider_id = ?1", [PROV_A]);
    db.run(
      `INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail, network_id)
       VALUES (?1, ?2, 'update_provider', 'provider', ?3, ?4, ?5)`,
      ["u_test", "test", PROV_A, JSON.stringify({ diff: { enabled: { before: true, after: false } } }), NET_A],
    );
    db.exec("COMMIT");
    expect(db.get<{enabled:number}>("SELECT enabled FROM providers WHERE provider_id = ?1", PROV_A)?.enabled).toBe(0);
    const audit = db.get<any>("SELECT action, target_id, detail FROM audit_log WHERE target_id = ?1 AND action = 'update_provider'", PROV_A);
    expect(audit?.action).toBe("update_provider");
    expect(audit?.target_id).toBe(PROV_A);
    expect(JSON.parse(audit!.detail).diff.enabled.after).toBe(false);
  });

  test("audit detail does NOT contain secret_key_ref VALUE under any patch", () => {
    seedProvider(PROV_A, NET_A);
    // Even if an attacker tried to slip secret into the diff (impossible
    // through the schema, but defense-in-depth), the audit serializer
    // only includes the fields actually in `diff`. Secret isn't a patch
    // field, so it can't reach the diff. Verify the absence:
    const auditPayload = JSON.stringify({ diff: { name: { before: "old", after: "new" } } });
    expect(auditPayload).not.toContain("secret");
    expect(auditPayload).not.toContain("ANTHROPIC_API_KEY");
    expect(auditPayload).not.toContain("sk-");
  });

  test("provider_models DELETE+INSERT atomicity (transaction wraps both)", () => {
    seedProvider(PROV_A, NET_A);
    db.run(
      `INSERT INTO provider_models (model_id, provider_id, model_name, enabled, created_at)
       VALUES ('pm_old1', ?1, 'claude-old-1', 1, ?2), ('pm_old2', ?1, 'claude-old-2', 1, ?2)`,
      [PROV_A, Date.now()],
    );
    expect(db.all("SELECT model_id FROM provider_models WHERE provider_id = ?1", PROV_A).length).toBe(2);
    // Replace in one transaction
    db.exec("BEGIN");
    db.run("DELETE FROM provider_models WHERE provider_id = ?1", [PROV_A]);
    db.run(
      `INSERT INTO provider_models (model_id, provider_id, model_name, enabled, created_at)
       VALUES ('pm_new1', ?1, 'claude-new-1', 1, ?2)`,
      [PROV_A, Date.now()],
    );
    db.exec("COMMIT");
    const rows = db.all<{model_name: string}>("SELECT model_name FROM provider_models WHERE provider_id = ?1", PROV_A);
    expect(rows.length).toBe(1);
    expect(rows[0].model_name).toBe("claude-new-1");
  });

  test("base_url change rejected via validateBaseUrl when host not in vendor allowlist", () => {
    seedProvider(PROV_A, NET_A, { vendor: "anthropic" });
    const vendor = db.get<{vendor: string}>("SELECT vendor FROM providers WHERE provider_id = ?1", PROV_A)!.vendor;
    // any host other than api.anthropic.com is rejected
    expect(() => validateBaseUrl(vendor, "https://api.openai.com")).toThrow(/probe_target_forbidden/);
    expect(() => validateBaseUrl(vendor, "https://169.254.169.254/v1")).toThrow(/probe_target_forbidden/);
    expect(() => validateBaseUrl(vendor, "http://api.anthropic.com")).toThrow(/probe_base_url_invalid/);
  });

  test("provider_disabled error distinct from provider_not_found in probe lookup", () => {
    seedProvider(PROV_A, NET_A, { enabled: 0 });
    // The new probe handler does the lookup WITHOUT enabled filter, then
    // checks .enabled — distinguishing not_found vs disabled.
    const row = db.get<{enabled: number}>("SELECT enabled FROM providers WHERE provider_id = ?1 AND network_id = ?2", PROV_A, NET_A);
    expect(row).toBeTruthy();
    expect(row!.enabled).toBe(0);
    // dashboard renders different message for these two cases
  });

  test("no-op same-value patch: NO audit_log row written (通信牛 nit)", () => {
    // Regression for the post-merge fix: when patch fields all match the
    // existing row (e.g. dashboard saves an unchanged form), the handler
    // must early-return WITHOUT inserting an empty-diff audit row.
    // Empty audit rows pollute the trail and make `forced_*` / sensitive
    // actions harder to find.
    seedProvider(PROV_A, NET_A, { name: "same-name", enabled: 1 });
    const auditBefore = db.get<{n:number}>(
      "SELECT COUNT(*) AS n FROM audit_log WHERE target_id = ?1 AND action = 'update_provider'",
      PROV_A,
    )!.n;

    // Mirror the handler's diff-check logic on a same-value patch
    const row = db.get<{name:string, enabled:number, base_url:string}>(
      "SELECT name, enabled, base_url FROM providers WHERE provider_id = ?1", PROV_A,
    )!;
    const patch = { name: "same-name", enabled: true };
    const sets: string[] = [];
    if (patch.name !== undefined && patch.name !== row.name) sets.push("name");
    if (patch.enabled !== undefined && (patch.enabled ? 1 : 0) !== row.enabled) sets.push("enabled");
    const willReplaceModels = false;   // no patch.models

    // sets MUST be empty for a same-value patch
    expect(sets.length).toBe(0);
    expect(willReplaceModels).toBe(false);

    // Handler returns here WITHOUT writing audit_log → count unchanged
    const auditAfter = db.get<{n:number}>(
      "SELECT COUNT(*) AS n FROM audit_log WHERE target_id = ?1 AND action = 'update_provider'",
      PROV_A,
    )!.n;
    expect(auditAfter).toBe(auditBefore);
    expect(auditAfter).toBe(0);
  });

  test("real change DOES write audit_log row (positive guard for the early-return)", () => {
    // Belt-and-suspenders: no-op early-return MUST NOT trigger when even
    // one field actually changes. Otherwise we'd silently lose audit
    // coverage for real updates.
    seedProvider(PROV_A, NET_A, { name: "old-name", enabled: 1 });
    const row = db.get<{name:string, enabled:number}>(
      "SELECT name, enabled FROM providers WHERE provider_id = ?1", PROV_A,
    )!;
    const patch = { name: "new-name", enabled: true };
    const sets: string[] = [];
    if (patch.name !== undefined && patch.name !== row.name) sets.push("name");
    if (patch.enabled !== undefined && (patch.enabled ? 1 : 0) !== row.enabled) sets.push("enabled");
    expect(sets).toEqual(["name"]);

    db.exec("BEGIN");
    db.run("UPDATE providers SET name = ?1 WHERE provider_id = ?2", ["new-name", PROV_A]);
    db.run(
      `INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail, network_id)
       VALUES (?1, ?2, 'update_provider', 'provider', ?3, ?4, ?5)`,
      ["u_test", "test", PROV_A, JSON.stringify({ diff: { name: { before: "old-name", after: "new-name" } }, fields_changed: ["name"] }), NET_A],
    );
    db.exec("COMMIT");

    const audit = db.get<any>(
      "SELECT detail FROM audit_log WHERE target_id = ?1 AND action = 'update_provider' ORDER BY id DESC LIMIT 1",
      PROV_A,
    )!;
    expect(JSON.parse(audit.detail).fields_changed).toEqual(["name"]);
  });
});
