import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteAdapter } from "./db-adapter";
import type { DbAdapter } from "./db-adapter";
import { createSessionSourceGrantStore, sessionSourceGrantSchema, type SessionSourceBinding } from "./session-source-grant";

test("source grant binds every authority dimension and claims once across connections and reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "source4150-")), file = join(root, "grants.db");
  const a = new SQLiteAdapter(new Database(file));
  let b = new SQLiteAdapter(new Database(file));
  try {
    a.exec(sessionSourceGrantSchema);
    const first = createSessionSourceGrantStore(a), second = createSessionSourceGrantStore(b);
    const source: SessionSourceBinding = { user_id: "user_a", network_id: "net_a", source_node_id: "node_source",
      daemon_node_id: "daemon_a", session_id: "ses_Source", binding_id: "binding_a",
      server_generation: "generation_proof_a", canonical_directory: "/workspace/source", mode: "attach_existing" };
    const ref = first.issue(source, 1000, 2000);
    expect(ref).toMatch(/^src_[A-Za-z0-9_-]{43}$/);
    expect(first.claimedRequest(ref, source)).toBeNull();
    for (const field of Object.keys(source) as (keyof SessionSourceBinding)[]) {
      const changed = { ...source, [field]: field === "mode" ? "fork_independent" : `${source[field]}_other` };
      expect(second.claim(ref, changed as SessionSourceBinding, "cr_wrong", 1500)).toBe(false);
    }
    expect(second.claim(ref, source, "cr_early", 999)).toBe(false);
    expect(second.claim(ref, source, "cr_expired", 2000)).toBe(false);
    expect(first.claim(ref, source, "cr_first", 1500)).toBe(true);
    expect(second.claimedRequest(ref, source)).toBe("cr_first");
    for (const field of Object.keys(source) as (keyof SessionSourceBinding)[]) {
      const changed = { ...source, [field]: field === "mode" ? "fork_independent" : `${source[field]}_other` };
      expect(second.claimedRequest(ref, changed as SessionSourceBinding)).toBeNull();
    }
    expect(second.claim(ref, source, "cr_second", 1500)).toBe(false);
    expect(second.claim(ref, source, "cr_first", 1500)).toBe(false);
    b.close(); b = new SQLiteAdapter(new Database(file));
    expect(createSessionSourceGrantStore(b).claimedRequest(ref, source)).toBe("cr_first");
    expect(createSessionSourceGrantStore(b).claim(ref, source, "cr_late_replay", 3000)).toBe(false);
    expect(createSessionSourceGrantStore(b).claimedRequest(ref, source)).toBe("cr_first");
    expect(createSessionSourceGrantStore(b).claim(ref, source, "cr_after_restart", 1500)).toBe(false);
    const other = first.issue(source, 1000, 2000);
    expect(first.claim(other, source, "cr_first", 1500)).toBe(false);
    expect(first.revoke(other)).toBe(true);
    expect(first.claimedRequest(other, source)).toBeNull();
    expect(first.claim(other, source, "cr_revoked", 1500)).toBe(false);
    expect(first.revoke(ref)).toBe(false);
    expect(() => first.issue(source, 1000, 61_001)).toThrow("session_source_grant_invalid");
    expect(() => first.issue({ ...source, canonical_directory: "bad\npath" }, 1000, 2000)).toThrow();
    expect(() => first.issue({ ...source, session_id: "latest" }, 1000, 2000)).toThrow();
    expect(first.claim("not_a_ref", source, "cr_test", 1500)).toBe(false);
    expect(first.claimedRequest("not_a_ref", source)).toBeNull();
    const forkSource = { ...source, mode: "fork_independent" as const };
    const forkRef = first.issue(forkSource, 1000, 2000);
    const reopened = createSessionSourceGrantStore(b);
    expect(reopened.claim(forkRef, forkSource, "cr_fork", 1500)).toBe(true);
    expect(reopened.claim(forkRef, forkSource, "cr_fork", 1500)).toBe(false);
  } finally { a.close(); b.close(); rmSync(root, { recursive: true, force: true }); }
});

test("source grants refuse unsupported adapters before issuing any SQL", () => {
  const db = { dialect: "postgres", transactionalFeaturesRefusal: null,
    run: () => { throw Error("SQL must not execute"); } } as unknown as DbAdapter;
  const store = createSessionSourceGrantStore(db);
  const source: SessionSourceBinding = { user_id: "u", network_id: "n", source_node_id: "s", daemon_node_id: "d",
    session_id: "ses_Source", binding_id: "b", server_generation: "g", canonical_directory: "/work", mode: "attach_existing" };
  expect(() => store.issue(source, 1000, 2000)).toThrow("session_source_grant_invalid");
  expect(store.claim(`src_${"a".repeat(43)}`, source, "cr_test", 1500)).toBe(false);
  expect(store.revoke(`src_${"a".repeat(43)}`)).toBe(false);
  expect(store.claimedRequest(`src_${"a".repeat(43)}`, source)).toBeNull();
});

test("source grants require affirmative atomic transaction support", () => {
  const source: SessionSourceBinding = { user_id: "u", network_id: "n", source_node_id: "s", daemon_node_id: "d",
    session_id: "ses_Source", binding_id: "b", server_generation: "g", canonical_directory: "/work", mode: "attach_existing" };
  for (const atomicTransactions of [false, undefined]) {
    const db = { dialect: "sqlite", atomicTransactions, transactionalFeaturesRefusal: null,
      run: () => { throw Error("SQL must not execute"); } } as unknown as DbAdapter;
    const store = createSessionSourceGrantStore(db);
    expect(() => store.issue(source, 1000, 2000)).toThrow("session_source_grant_invalid");
    expect(store.claim(`src_${"a".repeat(43)}`, source, "cr_test", 1500)).toBe(false);
    expect(store.revoke(`src_${"a".repeat(43)}`)).toBe(false);
    expect(store.claimedRequest(`src_${"a".repeat(43)}`, source)).toBeNull();
  }
});

test("source claim composes with same-connection intent insertion without partial admission", () => {
  const db = new SQLiteAdapter(new Database(":memory:"));
  try {
    db.exec(sessionSourceGrantSchema);
    // Storage composition fixture, NOT the production create-node adapter.
    db.exec("CREATE TABLE admission_fixture (request_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE)");
    const store = createSessionSourceGrantStore(db);
    const source: SessionSourceBinding = { user_id: "u", network_id: "n", source_node_id: "s", daemon_node_id: "d",
      session_id: "ses_Source", binding_id: "b", server_generation: "g", canonical_directory: "/work", mode: "attach_existing" };
    const ref = store.issue(source, 1000, 2000);
    db.run("INSERT INTO admission_fixture VALUES (?1,?2)", ["cr_existing", "taken"]);
    expect(() => db.transaction(() => {
      expect(store.claim(ref, source, "cr_new", 1500)).toBe(true);
      db.run("INSERT INTO admission_fixture VALUES (?1,?2)", ["cr_new", "taken"]);
    })).toThrow();
    expect(db.get("SELECT state,create_request_id FROM session_source_grants WHERE source_ref=?1", ref))
      .toEqual({ state: "issued", create_request_id: null });
    expect(db.get("SELECT request_id FROM admission_fixture WHERE request_id=?1", "cr_new")).toBeNull();
    db.transaction(() => {
      expect(store.claim(ref, source, "cr_new", 1500)).toBe(true);
      db.run("INSERT INTO admission_fixture VALUES (?1,?2)", ["cr_new", "available"]);
    });
    expect(db.get("SELECT state,create_request_id FROM session_source_grants WHERE source_ref=?1", ref))
      .toEqual({ state: "claimed", create_request_id: "cr_new" });
    expect(db.get("SELECT request_id FROM admission_fixture WHERE request_id=?1", "cr_new"))
      .toEqual({ request_id: "cr_new" });
    // A lost response after commit must not reopen the grant or replay creation.
    expect(store.claim(ref, source, "cr_new", 1500)).toBe(false);
    expect(db.get<{ count: number }>("SELECT count(*) AS count FROM admission_fixture")?.count).toBe(2);
  } finally { db.close(); }
});
