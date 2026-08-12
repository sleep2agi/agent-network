import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { trustedConfigSnapshotForNode, upsertNodeWithSec1Guard } from "./tools.js";

const NET = "net_peer_cap_698";
const USER = "user_peer_cap_698";

function seedToken(tokenId: string, nodeId: string | null) {
  db.run(
    "INSERT OR IGNORE INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))",
    [USER, USER],
  );
  db.run(
    "INSERT OR IGNORE INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))",
    [NET, NET, USER],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, bound_node_id)
     VALUES (?1, ?2, ?3, ?4, ?5, 'network', ?6)`,
    [tokenId, `hash_${tokenId}`, USER, NET, `node:${tokenId}`, nodeId],
  );
}

beforeEach(() => {
  db.run("DELETE FROM nodes WHERE network_id = ?1", NET);
  db.run("DELETE FROM api_tokens WHERE network_id = ?1", NET);
});

describe("peer reply inbox capability provenance", () => {
  test("exact token-bound node retains the capability", () => {
    seedToken("tok_cap_exact", "node_cap_exact");
    const snapshot = trustedConfigSnapshotForNode(
      { model: "m", peer_reply_inbox_capable: true },
      "tok_cap_exact",
      "node_cap_exact",
    ) as any;
    expect(snapshot.peer_reply_inbox_capable).toBe(true);
  });

  test("legacy unbound and wrong-node tokens cannot advertise it", () => {
    seedToken("tok_cap_legacy", null);
    seedToken("tok_cap_wrong", "node_other");
    for (const tokenId of ["tok_cap_legacy", "tok_cap_wrong", null]) {
      const snapshot = trustedConfigSnapshotForNode(
        { model: "m", peer_reply_inbox_capable: true },
        tokenId,
        "node_target",
      ) as any;
      expect(snapshot.peer_reply_inbox_capable).toBeUndefined();
      expect(snapshot.model).toBe("m");
    }
  });

  test("stored node snapshot is stripped for an unbound legacy token", () => {
    seedToken("tok_cap_store_legacy", null);
    expect(upsertNodeWithSec1Guard({
      node_id: "node_cap_store_legacy",
      callerNetworkId: NET,
      callerUserId: USER,
      callerTokenId: "tok_cap_store_legacy",
      alias: "legacy-cap-node",
      config_snapshot: { peer_reply_inbox_capable: true, model: "m" },
    }).result).toBe("inserted");
    const row = db.get<{ config_snapshot: string }>(
      "SELECT config_snapshot FROM nodes WHERE node_id = ?1",
      "node_cap_store_legacy",
    );
    expect(JSON.parse(row!.config_snapshot).peer_reply_inbox_capable).toBeUndefined();
  });
});
