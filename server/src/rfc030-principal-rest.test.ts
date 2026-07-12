// RFC-030 Wave 1B L1 — REST production-entry principal tests.
//
// Boots the REAL server (index.ts Bun.serve) on an isolated DB + random
// port and drives POST /api/task and POST /api/broadcast over real HTTP
// with a REAL utok minted by auth.ts issueUserToken — the full production
// auth chain (Authorization header → resolveToken → resolveSenderPrincipal
// stamp). No handler shortcuts.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpDb = join(mkdtempSync(join(tmpdir(), "rfc030-rest-")), "test.db");
process.env.COMMHUB_DB = tmpDb;
const PORT = 19000 + Math.floor(Math.random() * 2000);
process.env.PORT = String(PORT);

const { db } = await import("./db");
const { issueUserToken } = await import("./auth");
await import("./index"); // starts Bun.serve on PORT

const BASE = `http://127.0.0.1:${PORT}`;
const NET = "net_rest_stamp";
const U_MEMBER = "u_rest_member";
const TARGET = "rest-target";

let rawUtok = "";
let utokId = "";

beforeAll(() => {
  db.run(
    `INSERT INTO users (user_id, username, password_hash, role) VALUES (?1, 'rest-member', 'x', 'user')`,
    [U_MEMBER],
  );
  db.run(
    `INSERT INTO networks (network_id, network_name, owner_id) VALUES (?1, 'rest-net', ?2)`,
    [NET, U_MEMBER],
  );
  db.run(
    `INSERT INTO network_members (network_id, user_id, role) VALUES (?1, ?2, 'member')`,
    [NET, U_MEMBER],
  );
  db.run(
    `INSERT INTO sessions (resume_id, alias, network_id, last_seen_at, status)
     VALUES ('s_rest_target', ?1, ?2, datetime('now'), 'idle')`,
    [TARGET, NET],
  );
  // REAL production token mint (hash stored; we hold the raw bearer).
  const minted = issueUserToken(U_MEMBER, "rest-test-login");
  rawUtok = minted.token;
  utokId = minted.token_id;
});

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${rawUtok}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("REST /api/task — production entry principal stamp", () => {
  test("real HTTP + real utok: inbox + tasks stamped from AUTH principal; forged from_session is display-only", async () => {
    const { status, json } = await post("/api/task", {
      alias: TARGET,
      task: "rest stamped work",
      priority: "normal",
      from_session: "指挥室", // forged display — must NOT affect principal
      network_id: NET,
    });
    expect(status).toBeLessThan(300);
    expect(json.ok).toBe(true);
    const id = json.task_id as string;

    const inboxRow = db.get<Record<string, unknown>>(
      "SELECT * FROM inbox WHERE id = ?1", id)!;
    // REST derives its own display from_session ("api"/token binding) —
    // either way the DISPLAY value has zero bearing on the principal:
    expect(typeof inboxRow.from_session).toBe("string");
    expect(inboxRow.sender_token_id).toBe(utokId); // principal is the token's
    expect(inboxRow.sender_role).toBe("member"); // network_members role
    expect(inboxRow.canonical_task_id).toBe(id); // initial: self-canonical

    const taskRow = db.get<Record<string, unknown>>(
      "SELECT * FROM tasks WHERE task_id = ?1", id)!;
    expect(taskRow.origin_sender_token_id).toBe(utokId);
    expect(taskRow.origin_sender_role).toBe("member");
  });

  test("unauthenticated REST dispatch (open-dev/no token) → NULL principal", async () => {
    const res = await fetch(`${BASE}/api/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alias: TARGET,
        task: "rest unauth work",
        priority: "normal",
        network_id: NET,
      }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    // open-dev mode may accept or auth-refuse depending on server config;
    // the invariant under test: IF a row landed, it carries NO principal.
    if (json.ok === true) {
      const row = db.get<Record<string, unknown>>(
        "SELECT * FROM inbox WHERE id = ?1", json.task_id as string)!;
      expect(row.sender_token_id ?? null).toBeNull();
      expect(row.sender_role ?? null).toBeNull();
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("REST /api/broadcast — production entry principal stamp", () => {
  test("broadcast rows stamped with the operator's principal", async () => {
    // network scope for REST broadcast comes from the URL query
    // (resolveRestNetworkScope), not the body.
    const { status, json } = await post(`/api/broadcast?network_id=${NET}`, {
      message: "rest broadcast ping",
    });
    expect(status).toBeLessThan(300);
    expect(json.ok).toBe(true);
    const ids = json.message_ids as string[];
    expect(ids.length).toBeGreaterThanOrEqual(1);
    for (const id of ids) {
      const row = db.get<Record<string, unknown>>(
        "SELECT * FROM inbox WHERE id = ?1", id)!;
      expect(row.sender_token_id).toBe(utokId);
      expect(row.sender_role).toBe("member");
    }
  });
});
