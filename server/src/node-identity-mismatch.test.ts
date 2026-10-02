// report_status must not relabel a nodes row that belongs to another node.
//
// Shape seen in production: node A's config carries a node_id that another
// node B reported first (a copied config / a colliding hand-backfilled id).
// The row is B's alias + B's config_path, unowned (pre-RFC-036). When A starts
// reporting node_id, upsertNodeWithSec1Guard's COALESCE would overwrite the
// alias with A's — B's row silently becomes A's. identity_mismatch refuses it.
//
// Run with: COMMHUB_DB=/tmp/identity-mismatch.db bun test src/node-identity-mismatch.test.ts

import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { upsertNodeWithSec1Guard } from "./tools.js";

const NET = "net_identity";

function row(node_id: string, alias: string, config_path: string | null, owner: string | null = null) {
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, runtime, config_path, network_id, owner_user_id) VALUES (?1, ?2, ?2, 'codex-app-server-sdk', ?3, ?4, ?5)`,
    [node_id, alias, config_path, NET, owner],
  );
}
const read = (id: string) => db.get<{ alias: string; runtime: string | null; config_path: string | null }>(
  "SELECT alias, runtime, config_path FROM nodes WHERE node_id = ?1", id,
)!;

beforeEach(() => { db.run("DELETE FROM nodes"); });

describe("upsertNodeWithSec1Guard — identity_mismatch", () => {
  test("different alias + different config_path ⇒ refused, row untouched", () => {
    row("n_shared01", "node-b", "/work/b/.anet/nodes/node-b/config.json");
    const out = upsertNodeWithSec1Guard({
      node_id: "n_shared01", callerNetworkId: NET, alias: "node-a", runtime: "claude-code",
      config_path: "/work/a/.anet/nodes/node-a/config.json",
    });
    expect(out).toMatchObject({ result: "refused", reason: "identity_mismatch" });
    expect(read("n_shared01")).toEqual({ alias: "node-b", runtime: "codex-app-server-sdk", config_path: "/work/b/.anet/nodes/node-b/config.json" });
  });

  test("same alias, different config_path (the node moved dirs) ⇒ updated", () => {
    row("n_moved01", "node-a", "/old/.anet/nodes/node-a/config.json");
    const out = upsertNodeWithSec1Guard({ node_id: "n_moved01", callerNetworkId: NET, alias: "node-a", config_path: "/new/.anet/nodes/node-a/config.json" });
    expect(out.result).toBe("updated");
    expect(read("n_moved01").config_path).toBe("/new/.anet/nodes/node-a/config.json");
  });

  test("different alias, same config_path ⇒ updated (not the collision shape)", () => {
    row("n_same01", "old-name", "/w/.anet/nodes/x/config.json");
    expect(upsertNodeWithSec1Guard({ node_id: "n_same01", callerNetworkId: NET, alias: "new-name", config_path: "/w/.anet/nodes/x/config.json" }).result).toBe("updated");
    expect(read("n_same01").alias).toBe("new-name");
  });

  test("row without config_path (token-mint row) ⇒ first reporter fills it in", () => {
    row("n_mint01", "node-a", null);
    expect(upsertNodeWithSec1Guard({ node_id: "n_mint01", callerNetworkId: NET, alias: "node-a", config_path: "/w/a/config.json" }).result).toBe("updated");
    expect(read("n_mint01").config_path).toBe("/w/a/config.json");
  });

  test("reporter without config_path ⇒ no evidence, legacy behaviour kept", () => {
    row("n_nocfg01", "node-b", "/w/b/config.json");
    expect(upsertNodeWithSec1Guard({ node_id: "n_nocfg01", callerNetworkId: NET, alias: "node-a" }).result).toBe("updated");
  });

  test("new node_id ⇒ inserted", () => {
    expect(upsertNodeWithSec1Guard({ node_id: "n_fresh01", callerNetworkId: NET, alias: "node-a", config_path: "/w/a/config.json" }).result).toBe("inserted");
    expect(read("n_fresh01").alias).toBe("node-a");
  });

  test("owner mismatch still wins first (existing gate unchanged)", () => {
    row("n_owned01", "node-b", "/w/b/config.json", "usr_b");
    expect(upsertNodeWithSec1Guard({ node_id: "n_owned01", callerNetworkId: NET, callerUserId: "usr_a", alias: "node-a", config_path: "/w/a/config.json" }))
      .toMatchObject({ result: "refused", reason: "owner_mismatch" });
  });
});
