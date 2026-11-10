import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

test("existing users survive additive avatar migration and next process preserves it", async () => {
  const path = process.env.COMMHUB_DB!;
  expect(typeof path).toBe("string");
  const old = new Database(path);
  old.exec(`CREATE TABLE users (
    user_id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    email TEXT, display_name TEXT, role TEXT DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ); INSERT INTO users (user_id, username, password_hash) VALUES ('old_user', 'old_user', 'test-only-hash');`);
  old.close();
  const { db } = await import("./db.js");
  expect(db.get<any>("SELECT avatar_url, password_hash FROM users WHERE user_id = ?1", "old_user"))
    .toEqual({ avatar_url: null, password_hash: "test-only-hash" });
  db.run("UPDATE users SET avatar_url = ?1 WHERE user_id = ?2", ["/avatars/avatar-03.webp", "old_user"]);
  const child = Bun.spawn([process.execPath, "-e", `
    const { db } = await import('./src/db.ts');
    const row = db.get('SELECT avatar_url, password_hash FROM users WHERE user_id = ?1', 'old_user');
    if (row.avatar_url !== '/avatars/avatar-03.webp' || row.password_hash !== 'test-only-hash') process.exit(1);
  `], { cwd: new URL("..", import.meta.url).pathname, env: process.env, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
});
