import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteAdapter } from "./db-adapter";
import { createSessionForkStore, type ForkEntry } from "./session-fork-store";

test("fork journal persists intent and prevents two independent connections claiming the same write", () => {
  const root = mkdtempSync(join(tmpdir(), "fork590-store-"));
  const file = join(root, "journal.db");
  const a = new SQLiteAdapter(new Database(file));
  let b = new SQLiteAdapter(new Database(file));
  try {
    const source = readFileSync(new URL("./db.ts", import.meta.url), "utf8");
    const schema = source.match(/db\.exec\(`(CREATE TABLE IF NOT EXISTS session_fork_requests[\s\S]*?)`\);/)?.[1];
    expect(schema).toBeDefined(); a.exec(schema!);
    const first = createSessionForkStore(a), second = createSessionForkStore(b);
    const e: ForkEntry = { request_id: "fk_test_one", intent_id: "intent_one", operation: "fork",
      networkId: "net_one", nodeId: "node_one", tokenId: "token_row", requester: "user_token_row", requesterUser: "user_one",
      session_id: "ses_source", binding_id: "generation_one", expires_at: 1000, status: "pending" };
    expect(first.reserve(e).request_id).toBe(e.request_id);
    expect(second.reserve({ ...e, request_id: "fk_duplicate" }).request_id).toBe(e.request_id);
    expect(() => second.reserve({ ...e, request_id: "fk_busy", intent_id: "another_intent" })).toThrow();
    expect(second.intent("user_other", e.networkId, e.intent_id)).toBeUndefined();
    expect(first.claim(e, 999)).toBe(true);
    expect(second.claim(e, 999)).toBe(false);
    // Reopen the actual file, not just a new facade over the same connection.
    b.close(); b = new SQLiteAdapter(new Database(file));
    const restarted = createSessionForkStore(b);
    expect(restarted.get(e.request_id)?.status).toBe("in_progress");
    expect(restarted.claim(e, 999)).toBe(false);
    expect(restarted.settle({ ...e, status: "unknown", error: "session_fork_outcome_unknown" }, "in_progress").status).toBe("unknown");
    expect(first.settle({ ...e, status: "done", result: { session_id: "ses_child" } }, "in_progress").status).toBe("unknown");
    expect(first.reserve({ ...e, request_id: "fk_after_unknown" }).status).toBe("unknown");
    expect(first.claim(e, 999)).toBe(false);
    const next = { ...e, request_id: "fk_next", intent_id: "intent_next" };
    expect(first.reserve(next).status).toBe("pending");
    expect(first.claim(next, 1000)).toBe(false);
    expect(first.settle({ ...next, status: "expired", error: "session_control_request_expired" }, "pending").status).toBe("expired");
    expect(first.active()).toEqual([]);
  } finally { a.close(); b.close(); rmSync(root, { recursive: true, force: true }); }
});
