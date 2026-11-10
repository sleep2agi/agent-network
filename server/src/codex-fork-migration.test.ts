import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("legacy start table upgrades twice without changing ordinary rows or losing fork receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "fork-migration-"));
  const path = join(root, "legacy.db");
  try {
    let db = new Database(path);
    db.exec(`CREATE TABLE node_start_requests (
      request_id TEXT PRIMARY KEY, network_id TEXT NOT NULL, daemon_node_id TEXT NOT NULL,
      child_node_id TEXT NOT NULL, child_alias TEXT NOT NULL, created_by_token TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', error TEXT, child_pid INTEGER,
      created_at INTEGER NOT NULL, delivered_at INTEGER, acked_at INTEGER);
      INSERT INTO node_start_requests(request_id,network_id,daemon_node_id,child_node_id,child_alias,created_by_token,status,created_at)
        VALUES('str_legacy','net_fixture','node_daemon','node_child','fixture','fixture','started',1);`);
    db.close();
    const migrate = () => execFileSync(process.execPath, ["-e",
      `await import(${JSON.stringify(fileURLToPath(new URL("./db.ts", import.meta.url)))}); process.exit(0);`],
      { env: { ...process.env, COMMHUB_DB: path }, timeout: 15_000, stdio: "pipe" });
    migrate();
    db = new Database(path);
    expect(db.query("SELECT status,fork_recovery_json,fork_result_json FROM node_start_requests WHERE request_id='str_legacy'").get())
      .toEqual({ status: "started", fork_recovery_json: null, fork_result_json: null });
    const receipt = JSON.stringify({ state: "not_observed" });
    db.query("UPDATE node_start_requests SET fork_result_json=? WHERE request_id='str_legacy'").run(receipt);
    db.close();
    migrate();
    db = new Database(path);
    expect(db.query("SELECT fork_result_json FROM node_start_requests WHERE request_id='str_legacy'").get())
      .toEqual({ fork_result_json: receipt });
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
