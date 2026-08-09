import { Database } from "bun:sqlite";
import { dirname } from "path";
import { mkdirSync } from "fs";

const [command, dbPath] = Bun.argv.slice(2);
if (!command || !dbPath) throw new Error("usage: db-tool.ts <seed|read> <db-path>");

if (command === "seed") {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("CREATE TABLE users (user_id TEXT PRIMARY KEY, must_change_password INTEGER NOT NULL DEFAULT 0)");
  db.query("INSERT INTO users (user_id) VALUES ('user-661')").run();
  db.close();
} else if (command === "read") {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query<{ must_change_password: number }, []>(
    "SELECT must_change_password FROM users WHERE user_id = 'user-661'",
  ).get();
  db.close();
  process.stdout.write(String(row?.must_change_password ?? -1));
} else {
  throw new Error(`unknown command: ${command}`);
}
