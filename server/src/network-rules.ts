// #993 — network-scoped rules text.
//
// First slice: storage + a read/write API with a compare-and-swap revision and an
// audit entry. Inheritance (Hub → Daemon → node) is NOT implemented here: it needs
// a precedence and conflict story of its own, and shipping the storage first is
// what lets that be reviewed against real content.
//
// Deliberate choices:
//   * one row per network, text is the whole document (no chunking) — a team rule
//     file is a few kilobytes, and partial reads would make "which revision did I
//     read" ambiguous;
//   * `revision` starts at 1 for the first write; reads before any write report
//     revision 0 and empty content, so a client can PUT with expected_revision 0
//     without a special "create" path;
//   * the size cap is measured in UTF-8 bytes, not UTF-16 units, because the
//     content is a file the node will write to disk.
import type { DbAdapter } from "./db-adapter.js";

/** 200 KiB. A team rule file is small; anything near this is a mistake. */
export const NETWORK_RULES_MAX_BYTES = 200 * 1024;

export type NetworkRules = {
  network_id: string;
  content: string;
  revision: number;
  updated_at: string | null;
  updated_by: { user_id: string; username: string | null } | null;
};

type Row = { content: string; revision: number; updated_at: string; updated_by_json: string | null };

export function ensureNetworkRules(database: DbAdapter): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS network_rules (
      network_id      TEXT NOT NULL PRIMARY KEY,
      content         TEXT NOT NULL,
      revision        INTEGER NOT NULL,
      updated_at      TEXT NOT NULL,
      updated_by_json TEXT
    );
  `);
}

let ensured = false;
/** Idempotent: the table is created on first use, not on every request. */
export function ensureNetworkRulesOnce(database: DbAdapter): void {
  if (ensured) return;
  ensureNetworkRules(database);
  ensured = true;
}

function current(database: DbAdapter, networkId: string): Row | null {
  return database.get<Row>(
    "SELECT content, revision, updated_at, updated_by_json FROM network_rules WHERE network_id = ?1",
    networkId,
  ) ?? null;
}

export function readNetworkRules(database: DbAdapter, networkId: string): NetworkRules {
  const row = current(database, networkId);
  if (!row) return { network_id: networkId, content: "", revision: 0, updated_at: null, updated_by: null };
  let updatedBy: NetworkRules["updated_by"] = null;
  try {
    const parsed = JSON.parse(row.updated_by_json ?? "null");
    if (parsed && typeof parsed === "object" && typeof parsed.user_id === "string") {
      updatedBy = { user_id: parsed.user_id, username: typeof parsed.username === "string" ? parsed.username : null };
    }
  } catch { /* a corrupt actor blob must not make the rules unreadable */ }
  return {
    network_id: networkId,
    content: row.content,
    revision: Number(row.revision) || 0,
    updated_at: row.updated_at,
    updated_by: updatedBy,
  };
}

export type WriteResult =
  | { ok: true; rules: NetworkRules }
  | { ok: false; status: number; error: "invalid_rules_content" | "rules_too_large" | "rules_revision_conflict" };

/**
 * Compare-and-swap write. `expectedRevision` is required: a blind PUT would let two
 * clients overwrite each other, and this is the same document every node in the
 * network would inherit.
 */
export function writeNetworkRules(
  database: DbAdapter,
  networkId: string,
  content: unknown,
  expectedRevision: unknown,
  actor: { user_id: string; username: string | null },
  now = new Date().toISOString(),
): WriteResult {
  if (typeof content !== "string") return { ok: false, status: 400, error: "invalid_rules_content" };
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return { ok: false, status: 400, error: "invalid_rules_content" };
  }
  if (Buffer.byteLength(content, "utf8") > NETWORK_RULES_MAX_BYTES) {
    return { ok: false, status: 413, error: "rules_too_large" };
  }
  const row = current(database, networkId);
  const revision = row ? Number(row.revision) || 0 : 0;
  if (revision !== expectedRevision) return { ok: false, status: 409, error: "rules_revision_conflict" };
  const next = revision + 1;
  const actorJson = JSON.stringify({ user_id: actor.user_id, username: actor.username });
  if (row) {
    database.run(
      "UPDATE network_rules SET content = ?1, revision = ?2, updated_at = ?3, updated_by_json = ?4 WHERE network_id = ?5",
      [content, next, now, actorJson, networkId],
    );
  } else {
    database.run(
      "INSERT INTO network_rules (network_id, content, revision, updated_at, updated_by_json) VALUES (?1, ?2, ?3, ?4, ?5)",
      [networkId, content, next, now, actorJson],
    );
  }
  return { ok: true, rules: readNetworkRules(database, networkId) };
}
