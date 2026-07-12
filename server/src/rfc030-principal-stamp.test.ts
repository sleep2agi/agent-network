// RFC-030 Wave 1B — sender principal stamp (approved <2h scope exception).
//
// 铁律 coverage:
//   1. Migration is additive/backcompat: legacy rows read fine with null
//      principal; get_inbox behavior for existing consumers unchanged.
//   2. sender_token_id/sender_role come ONLY from the server auth context
//      (callerTokenId → api_tokens row) — never from from_session / args.
//   3. Forged from_session alias yields NO valid principal.
//   4. Legacy nullable rows remain readable by normal runtimes while the
//      Gateway alone refuses (fail closed) — asserted with the gateway's
//      own senderFromInboxRow.
//
// The suite uses an isolated COMMHUB_DB (never the production default).

import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolated DB BEFORE importing db.ts (which opens on import).
const tmpDb = join(mkdtempSync(join(tmpdir(), "rfc030-stamp-")), "test.db");
process.env.COMMHUB_DB = tmpDb;

const { db } = await import("./db");
// Gateway-side fail-closed constructor (agent-node source, imported
// directly — same repo, test-only import).
const { senderFromInboxRow } = await import(
  "../../agent-node/src/runtime/codex-policy-gateway/bridge-adapter"
);

function insertLegacyRow(id: string, fromSession: string) {
  // Simulates a pre-migration writer: no principal columns in the INSERT.
  db.run(
    `INSERT INTO inbox (id, session_name, type, priority, content, from_session, network_id)
     VALUES (?1, ?2, 'task', 'normal', 'legacy content', ?3, 'net_default')`,
    [id, "target-node", fromSession],
  );
}

describe("RFC-030 principal stamp — migration + backcompat", () => {
  beforeAll(() => {
    // Seed an api_tokens row = the authenticated caller.
    db.run(
      `INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, role)
       VALUES ('tok_real_1', 'hash_x', 'user_1', 'net_default', 'test', 'member')`,
      [],
    );
  });

  test("inbox has the new nullable columns; legacy insert (no principal) still works", () => {
    insertLegacyRow("legacy_1", "some-agent");
    const row = db.get<Record<string, unknown>>(
      "SELECT * FROM inbox WHERE id = ?1",
      "legacy_1",
    )!;
    expect(row.content).toBe("legacy content");
    expect(row.sender_token_id ?? null).toBeNull();
    expect(row.sender_role ?? null).toBeNull();
  });

  test("stamped insert carries the api_tokens role (server-side resolution)", () => {
    // Mirror the tools.ts stamp: resolve role from api_tokens, not args.
    const principal = db.get<{ role: string | null }>(
      "SELECT role FROM api_tokens WHERE token_id = ?1",
      "tok_real_1",
    );
    expect(principal?.role).toBe("member");
    db.run(
      `INSERT INTO inbox (id, session_name, type, priority, content, from_session, network_id, sender_token_id, sender_role)
       VALUES ('stamped_1', 'target-node', 'task', 'normal', 'x', 'reviewer', 'net_default', ?1, ?2)`,
      ["tok_real_1", principal!.role],
    );
    const row = db.get<Record<string, unknown>>(
      "SELECT sender_token_id, sender_role, from_session FROM inbox WHERE id = 'stamped_1'",
    )!;
    expect(row.sender_token_id).toBe("tok_real_1");
    expect(row.sender_role).toBe("member");
  });

  test("get_inbox-shaped select returns principal fields without breaking legacy rows", () => {
    const rows = db.all<Record<string, unknown>>(
      `SELECT id, type, priority, content, context, from_session, created_at, network_id, meta_json, sender_token_id, sender_role
       FROM inbox WHERE session_name = 'target-node' AND acked = 0 ORDER BY created_at`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const legacy = rows.find((r) => r.id === "legacy_1")!;
    const stamped = rows.find((r) => r.id === "stamped_1")!;
    expect(legacy.sender_token_id ?? null).toBeNull();
    expect(stamped.sender_token_id).toBe("tok_real_1");
  });
});

describe("RFC-030 principal stamp — forged alias cannot mint a principal", () => {
  test("forged_from_session_alias_yields_no_valid_AuthenticatedSender", () => {
    // Attacker controls from_session ('指挥室' impersonation) but has no
    // token context → columns stay null → the gateway refuses.
    insertLegacyRow("forged_1", "指挥室");
    const row = db.get<Record<string, unknown>>(
      `SELECT id, from_session, network_id, sender_token_id, sender_role
       FROM inbox WHERE id = 'forged_1'`,
    )!;
    expect(row.from_session).toBe("指挥室"); // display alias forged fine…
    const sender = senderFromInboxRow({
      id: String(row.id),
      from_session: row.from_session as string,
      network_id: row.network_id as string,
      sender_token_id: (row.sender_token_id as string | null) ?? null,
      sender_role: (row.sender_role as string | null) ?? null,
    });
    expect(sender).toBeNull(); // …but the gateway refuses it.
  });

  test("a bogus role value in the column also fails closed at the gateway", () => {
    db.run(
      `INSERT INTO inbox (id, session_name, type, priority, content, from_session, network_id, sender_token_id, sender_role)
       VALUES ('bogus_role', 'target-node', 'task', 'normal', 'x', 'y', 'net_default', 'tok_real_1', 'superadmin')`,
      [],
    );
    const row = db.get<Record<string, unknown>>(
      "SELECT * FROM inbox WHERE id = 'bogus_role'",
    )!;
    const sender = senderFromInboxRow({
      id: "bogus_role",
      from_session: "y",
      network_id: "net_default",
      sender_token_id: row.sender_token_id as string,
      sender_role: row.sender_role as string,
    });
    expect(sender).toBeNull();
  });

  test("fully stamped row IS accepted by the gateway with the token identity", () => {
    const sender = senderFromInboxRow({
      id: "stamped_1",
      from_session: "reviewer",
      network_id: "net_default",
      sender_token_id: "tok_real_1",
      sender_role: "member",
    });
    expect(sender).not.toBeNull();
    expect(sender!.tokenId).toBe("tok_real_1");
    expect(sender!.role).toBe("member");
    expect(sender!.alias).toBe("reviewer"); // display only
  });
});
