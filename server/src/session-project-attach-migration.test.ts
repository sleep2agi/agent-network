import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionProjectCreateSchema, migrateProjectOperationJournal } from "./session-source-admission-store";

test("actual old on-disk journal migrates twice and keeps new-session rows and intent tombstones", () => {
  const path = join(mkdtempSync(join(tmpdir(), "attach-migration-")), "old.db");
  let sql = new Database(path);
  sql.exec(sessionProjectCreateSchema);
  sql.run(`INSERT INTO session_project_creates
    (request_id,user_id,requester_token_id,network_id,source_node_id,daemon_node_id,daemon_token_id,daemon_instance_id,
    intent_id,selection_scope,snapshot_id,project_id,child_name,accepted_at,expires_at,state,session_id)
    VALUES ('old','u','t','n','s','d','dt','di','intent','scope','snap','oprj_old','child',1,2,'unknown_rotation_required','ses_Old')`);
  sql.close(); sql = new Database(path);
  const adapter = { dialect: "sqlite", all: (q: string) => sql.query(q).all(), exec: (q: string) => sql.exec(q) };
  migrateProjectOperationJournal(adapter); migrateProjectOperationJournal(adapter);
  expect(sql.query("SELECT operation_kind,selected_session_id,project_id,session_id,state FROM session_project_creates").get()).toEqual({
    operation_kind: "project_new_session", selected_session_id: null, project_id: "oprj_old", session_id: "ses_Old", state: "unknown_rotation_required" });
  expect(() => sql.run("INSERT INTO session_project_creates SELECT * FROM session_project_creates")).toThrow();
  sql.close();
});
