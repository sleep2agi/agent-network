#!/usr/bin/env bun
// Board #741 — read-only inventory. This script reports invalid stored aliases;
// it never updates them. Run it against a DB copy or an explicitly read-only file.
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { aliasControlCharacter, describeAliasControlCharacter } from "../src/node-alias-control.js";

const input = process.argv[2];
if (!input) {
  console.error("usage: bun server/scripts/scan-node-aliases.ts <commhub.db>");
  process.exit(2);
}

const database = new Database(resolve(input), { readonly: true });
const rows = database.query<{ source: string; record_id: string; alias: string }, []>(
  `SELECT 'nodes' AS source, node_id AS record_id, alias FROM nodes WHERE alias IS NOT NULL
   UNION ALL
   SELECT 'sessions' AS source, resume_id AS record_id, alias FROM sessions WHERE alias IS NOT NULL
   ORDER BY source, record_id`,
).all();
let invalid = 0;
for (const row of rows) {
  const control = aliasControlCharacter(row.alias);
  if (control === null) continue;
  invalid++;
  console.log(JSON.stringify({ source: row.source, record_id: row.record_id, alias: row.alias, reason: "control_character", char: describeAliasControlCharacter(control) }));
}
console.error(JSON.stringify({ scanned: rows.length, invalid, readonly: true }));
database.close();
