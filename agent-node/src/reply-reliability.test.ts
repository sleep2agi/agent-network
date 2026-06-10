// #168 reply-reliability unit tests.
//
// 7-case coverage matrix per RFC-016 + 通信牛 二审 amend:
//
//   1. JSON-RPC error envelope → retryable error
//   2. MCP result.isError → retryable error
//   3. App-level ok:false → appLevel CommHubError (non-retryable)
//   4. Successful payload → kind:"ok" with parsed body
//   5. Non-JSON tool text → passed through verbatim (legacy callers
//      that expect prose still work)
//   6. PendingReplyQueue idempotency: same (to, taskId) only stored
//      once; attempts counter preserved across re-persist
//   7. drain() — successful drain clears, transient failure requeues
//      with attempts++, app-level failure drops loudly
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  classifyCommHubResponse,
  CommHubError,
  PendingReplyQueue,
  quickHash,
} from "./reply-reliability";

describe("classifyCommHubResponse", () => {
  test("returns ok with parsed application payload (the happy path)", () => {
    const data = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: JSON.stringify({ ok: true, message_id: "msg_123" }) }],
      },
    };
    const r = classifyCommHubResponse(data);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.payload.ok).toBe(true);
      expect(r.payload.message_id).toBe("msg_123");
    }
  });

  test("JSON-RPC error envelope → retryable CommHubError", () => {
    const data = { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "SQLite WAL busy" } };
    const r = classifyCommHubResponse(data);
    expect(r.kind).toBe("retryable");
    if (r.kind === "retryable") {
      expect(r.error.message).toContain("SQLite WAL busy");
      expect(r.error.code).toBe(-32000);
      expect(r.error.appLevel).toBe(false);
    }
  });

  test("MCP result.isError → retryable CommHubError", () => {
    const data = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        isError: true,
        content: [{ type: "text", text: "tool failed mid-flight" }],
      },
    };
    const r = classifyCommHubResponse(data);
    expect(r.kind).toBe("retryable");
    if (r.kind === "retryable") {
      expect(r.error.message).toContain("tool failed mid-flight");
      expect(r.error.appLevel).toBe(false);
    }
  });

  test("application-level ok:false → appLevel CommHubError (NON-retryable)", () => {
    // Exactly the shape #212 dedup returns. Treating this as success
    // (the previous silent-lost) is the #168 RC-B2 bug; treating it as
    // retryable would melt down the LLM with the same #212 storm
    // pattern. It must be non-retryable AND surfaced clearly.
    const data = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: "duplicate_send",
              message: "同内容任务 5 分钟内已发给 A站负责人, 如确需重发请改写内容或等待。",
            }),
          },
        ],
      },
    };
    const r = classifyCommHubResponse(data);
    expect(r.kind).toBe("appLevel");
    if (r.kind === "appLevel") {
      expect(r.error.appLevel).toBe(true);
      expect(r.error.message).toContain("duplicate_send");
      expect(r.error.payload?.error).toBe("duplicate_send");
    }
  });

  test("non-JSON tool text is passed through verbatim", () => {
    const data = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "raw prose response with no JSON" }] },
    };
    const r = classifyCommHubResponse(data);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.payload).toBe("raw prose response with no JSON");
  });

  test("data with neither error nor result returns ok with the raw data", () => {
    // Legacy callers sometimes receive a hub announcement / heartbeat
    // shape without the standard envelope; passing through keeps them
    // working.
    const data = { jsonrpc: "2.0", id: 1, custom: "value" };
    const r = classifyCommHubResponse(data);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.payload.custom).toBe("value");
  });
});

describe("CommHubError", () => {
  test("instances are distinguishable from generic Error via instanceof", () => {
    const e = new CommHubError("boom");
    expect(e instanceof CommHubError).toBe(true);
    expect(e instanceof Error).toBe(true);
    expect(e.name).toBe("CommHubError");
    expect(e.appLevel).toBe(false);
  });

  test("appLevel flag survives the throw/catch round trip", () => {
    const original = new CommHubError("nope", { appLevel: true, code: "duplicate_send" });
    try {
      throw original;
    } catch (caught: any) {
      expect(caught.appLevel).toBe(true);
      expect(caught.code).toBe("duplicate_send");
    }
  });
});

describe("PendingReplyQueue", () => {
  function freshDir(): string {
    return mkdtempSync(join(tmpdir(), "anet-pending-reply-"));
  }

  test("load() returns empty array when file does not exist", () => {
    const dir = freshDir();
    try {
      const q = new PendingReplyQueue(join(dir, "pending.json"));
      expect(q.load()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persist + load round-trips an entry with attempts=0", () => {
    const dir = freshDir();
    try {
      const q = new PendingReplyQueue(join(dir, "pending.json"));
      q.persist({ to: "alice", text: "ack-1", taskId: "tsk_a", failed: false, queuedAt: 1 });
      const items = q.load();
      expect(items).toHaveLength(1);
      expect(items[0].to).toBe("alice");
      expect(items[0].taskId).toBe("tsk_a");
      expect(items[0].attempts).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persist is idempotent on (to, taskId) — attempts counter preserved", () => {
    const dir = freshDir();
    try {
      const q = new PendingReplyQueue(join(dir, "pending.json"));
      q.persist({ to: "alice", text: "v1", taskId: "tsk_a", failed: false, queuedAt: 1 });
      // Simulate one failed attempt; drain() bumps the counter by saving with attempts+1.
      let items = q.load();
      items[0].attempts = 3;
      items[0].lastError = "ECONNRESET";
      q.save(items);
      // Persist again with same (to, taskId) — should overwrite the body but PRESERVE attempts.
      q.persist({ to: "alice", text: "v2-updated", taskId: "tsk_a", failed: false, queuedAt: 2 });
      items = q.load();
      expect(items).toHaveLength(1);
      expect(items[0].text).toBe("v2-updated");
      expect(items[0].queuedAt).toBe(2);
      expect(items[0].attempts).toBe(3); // ← counter preserved across re-persist
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clear removes only the matching (to, taskId)", () => {
    const dir = freshDir();
    try {
      const q = new PendingReplyQueue(join(dir, "pending.json"));
      q.persist({ to: "alice", text: "x", taskId: "tsk_a", failed: false, queuedAt: 1 });
      q.persist({ to: "bob", text: "x", taskId: "tsk_b", failed: false, queuedAt: 2 });
      q.persist({ to: "alice", text: "y", taskId: "tsk_c", failed: false, queuedAt: 3 });
      q.clear("alice", "tsk_a");
      const items = q.load();
      expect(items).toHaveLength(2);
      expect(items.find((p) => p.taskId === "tsk_a")).toBeUndefined();
      expect(items.find((p) => p.taskId === "tsk_b")).toBeDefined();
      expect(items.find((p) => p.taskId === "tsk_c")).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PendingReplyQueue.drain", () => {
  function freshDir(): string {
    return mkdtempSync(join(tmpdir(), "anet-pending-reply-"));
  }

  test("delivers every entry on success and persists an empty queue", async () => {
    const dir = freshDir();
    try {
      const q = new PendingReplyQueue(join(dir, "pending.json"));
      q.persist({ to: "alice", text: "a", taskId: "tsk_a", failed: false, queuedAt: 1 });
      q.persist({ to: "bob", text: "b", taskId: "tsk_b", failed: false, queuedAt: 2 });
      const seen: string[] = [];
      const res = await q.drain(async (entry) => {
        seen.push(entry.taskId!);
      });
      expect(res.delivered).toBe(2);
      expect(res.dropped).toBe(0);
      expect(res.requeued).toBe(0);
      expect(seen.sort()).toEqual(["tsk_a", "tsk_b"]);
      expect(q.load()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("transient failure requeues with attempts++ and lastError", async () => {
    const dir = freshDir();
    try {
      const q = new PendingReplyQueue(join(dir, "pending.json"));
      q.persist({ to: "alice", text: "a", taskId: "tsk_a", failed: false, queuedAt: 1 });
      const res = await q.drain(async () => {
        throw new Error("ECONNRESET — hub is restarting");
      });
      expect(res.delivered).toBe(0);
      expect(res.dropped).toBe(0);
      expect(res.requeued).toBe(1);
      const items = q.load();
      expect(items).toHaveLength(1);
      expect(items[0].attempts).toBe(1);
      expect(items[0].lastError).toContain("ECONNRESET");
      expect(items[0].lastTryAt).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("app-level CommHubError is dropped loud — not retried, not requeued", async () => {
    // The #168 boundary with 通信牛's server-side fix: when the server
    // says "no, this task is already replied" (ok:false in #212 / #168
    // family), the runtime must NOT keep hammering the same dead key.
    // Drop the entry with a logged warning and move on.
    const dir = freshDir();
    try {
      const q = new PendingReplyQueue(join(dir, "pending.json"));
      q.persist({ to: "alice", text: "a", taskId: "tsk_a", failed: false, queuedAt: 1 });
      q.persist({ to: "alice", text: "b", taskId: "tsk_b", failed: false, queuedAt: 2 });
      let calls = 0;
      const res = await q.drain(async () => {
        calls++;
        if (calls === 1) throw new CommHubError("task already replied", { appLevel: true });
        // second call succeeds
      });
      expect(res.delivered).toBe(1);
      expect(res.dropped).toBe(1);
      expect(res.requeued).toBe(0);
      expect(q.load()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("drain on empty queue is a no-op and does not write the file", async () => {
    const dir = freshDir();
    try {
      const file = join(dir, "pending.json");
      const q = new PendingReplyQueue(file);
      const res = await q.drain(async () => {});
      expect(res).toEqual({ delivered: 0, dropped: 0, requeued: 0 });
      expect(existsSync(file)).toBe(false); // never wrote
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file format is stable JSON — readable by an operator after a crash", async () => {
    const dir = freshDir();
    try {
      const file = join(dir, "pending.json");
      const q = new PendingReplyQueue(file);
      q.persist({ to: "alice", text: "the actual reply body", taskId: "tsk_a", failed: false, queuedAt: 1700000000000 });
      const raw = readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].to).toBe("alice");
      expect(parsed[0].text).toBe("the actual reply body");
      expect(parsed[0].taskId).toBe("tsk_a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("quickHash", () => {
  test("is deterministic", () => {
    expect(quickHash("hello")).toBe(quickHash("hello"));
  });

  test("differs across inputs", () => {
    expect(quickHash("hello")).not.toBe(quickHash("world"));
  });

  test("returns 32-char hex", () => {
    expect(quickHash("anything")).toMatch(/^[0-9a-f]{32}$/);
  });
});
