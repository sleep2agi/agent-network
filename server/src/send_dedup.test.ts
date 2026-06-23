// Unit test for the #212 send_task dedup guardrail.
//
// Pure-function module — no DB, no MCP server, just verifies the dedup
// algebra: same key in window is rejected; different key (cross-from,
// cross-to, cross-content) is allowed; expired entry restored; disabled
// window short-circuits everything; structured payload contains both the
// Chinese hint the LLM is supposed to act on and machine-parseable
// details.
import { describe, expect, it } from "bun:test";
import {
  SendDedup,
  buildDuplicateSendPayload,
  readDedupConfig,
} from "./send_dedup.js";

describe("readDedupConfig", () => {
  it("defaults to 300000 ms window and 4096 max keys", () => {
    const cfg = readDedupConfig({});
    expect(cfg.windowMs).toBe(300_000);
    expect(cfg.maxKeys).toBe(4096);
  });

  it("respects COMMHUB_SEND_DEDUP_WINDOW_MS=0 to disable", () => {
    const cfg = readDedupConfig({ COMMHUB_SEND_DEDUP_WINDOW_MS: "0" });
    expect(cfg.windowMs).toBe(0);
  });

  it("parses custom window and max keys from env", () => {
    const cfg = readDedupConfig({
      COMMHUB_SEND_DEDUP_WINDOW_MS: "60000",
      COMMHUB_SEND_DEDUP_MAX_KEYS: "256",
    });
    expect(cfg.windowMs).toBe(60_000);
    expect(cfg.maxKeys).toBe(256);
  });

  it("clamps negative window to 0 and small max keys to 64", () => {
    const cfg = readDedupConfig({
      COMMHUB_SEND_DEDUP_WINDOW_MS: "-1",
      COMMHUB_SEND_DEDUP_MAX_KEYS: "1",
    });
    expect(cfg.windowMs).toBe(0);
    expect(cfg.maxKeys).toBe(64);
  });
});

describe("SendDedup", () => {
  it("flags a repeat send within the window", () => {
    const d = new SendDedup({ windowMs: 60_000, maxKeys: 32 });
    const t0 = 1_700_000_000_000;

    expect(d.check("alice", "bob", "hello", t0)).toEqual({ duplicate: false });
    d.record("alice", "bob", "hello", t0);

    const second = d.check("alice", "bob", "hello", t0 + 1000);
    expect(second.duplicate).toBe(true);
    if (second.duplicate) {
      expect(second.lastSentMs).toBe(t0);
      expect(second.ageMs).toBe(1000);
    }
  });

  it("allows the same content after the window elapses", () => {
    const d = new SendDedup({ windowMs: 60_000, maxKeys: 32 });
    const t0 = 1_700_000_000_000;
    d.record("alice", "bob", "hello", t0);

    const stillIn = d.check("alice", "bob", "hello", t0 + 59_000);
    expect(stillIn.duplicate).toBe(true);

    const past = d.check("alice", "bob", "hello", t0 + 60_001);
    expect(past).toEqual({ duplicate: false });
  });

  it("does not conflate different senders, targets, or contents", () => {
    const d = new SendDedup({ windowMs: 60_000, maxKeys: 32 });
    const t0 = 1_700_000_000_000;
    d.record("alice", "bob", "hello", t0);

    // Different sender → allowed.
    expect(d.check("carol", "bob", "hello", t0 + 1000)).toEqual({ duplicate: false });
    // Different target → allowed.
    expect(d.check("alice", "dave", "hello", t0 + 1000)).toEqual({ duplicate: false });
    // Different content → allowed (even with trailing whitespace tweak).
    expect(d.check("alice", "bob", "hello ", t0 + 1000)).toEqual({ duplicate: false });
    // Repeated original → still flagged.
    expect(d.check("alice", "bob", "hello", t0 + 1000).duplicate).toBe(true);
  });

  it("treats windowMs=0 as fully disabled", () => {
    const d = new SendDedup({ windowMs: 0, maxKeys: 32 });
    expect(d.enabled).toBe(false);
    d.record("alice", "bob", "hello", 1);
    expect(d.check("alice", "bob", "hello", 2)).toEqual({ duplicate: false });
    expect(d.size).toBe(0);
  });

  it("opportunistically evicts expired entries during check", () => {
    const d = new SendDedup({ windowMs: 10_000, maxKeys: 32 });
    d.record("alice", "bob", "hello", 1000);
    d.record("alice", "bob", "world", 1500);
    expect(d.size).toBe(2);

    // Far past both entries' window — check should evict both.
    expect(d.check("alice", "bob", "third", 100_000)).toEqual({ duplicate: false });
    expect(d.size).toBe(0);
  });

  it("caps map size by oldest-first eviction when exceeding maxKeys", () => {
    const d = new SendDedup({ windowMs: 600_000, maxKeys: 64 });
    for (let i = 0; i < 100; i++) {
      d.record(`from-${i}`, "bob", `content-${i}`, 1_000 + i);
    }
    // Eviction triggers when size > maxKeys; after eviction we keep ~90 %
    // of maxKeys, so size should land below maxKeys.
    expect(d.size).toBeLessThanOrEqual(64);
    expect(d.size).toBeGreaterThan(0);
  });

  it("evictOldest drops to exactly floor(maxKeys * 0.9) on the first trigger", () => {
    // Regression guard for the size-during-loop bug fixed in the
    // robustness pass. Insert exactly maxKeys+1 records to fire exactly
    // ONE evictOldest call, then snapshot size before any further inserts
    // can re-grow it. With the bug, the loop bound
    // `i < this.last.size - target` shrunk each iteration and only
    // ~half the intended deletions ran (e.g. 14 of 27 for maxKeys=256,
    // landing size at ~243 instead of 230). After the fix size lands at
    // the documented target = floor(maxKeys * 0.9).
    const maxKeys = 256;
    const target = Math.floor(maxKeys * 0.9); // 230
    const d = new SendDedup({ windowMs: 600_000, maxKeys });
    for (let i = 0; i <= maxKeys; i++) {
      d.record(`from-${i}`, "bob", `content-${i}`, 1_000 + i);
    }
    expect(d.size).toBe(target);
  });

  it("hashes content rather than holding the raw bytes", () => {
    // The key function is the public surface that proves we don't keep
    // raw content in memory between sends — the map keys themselves are
    // safe to log/inspect.
    const key = SendDedup.key("alice", "bob", "secret payload");
    expect(key.startsWith("alice|bob|")).toBe(true);
    expect(key).toMatch(/\|[0-9a-f]{64}$/);
    expect(key).not.toContain("secret");
  });
});

describe("buildDuplicateSendPayload", () => {
  it("contains the Chinese LLM-facing hint with target alias and window minutes", () => {
    const payload = buildDuplicateSendPayload({
      from: "A站Grok",
      to: "A站负责人",
      ageMs: 12_345,
      windowMs: 300_000,
    });
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("duplicate_send");
    expect(payload.message).toContain("5 分钟内已发给 A站负责人");
    expect(payload.message).toContain("改写内容或等待");
    expect(payload.details.age_ms).toBe(12_345);
    expect(payload.details.window_ms).toBe(300_000);
    expect(payload.details.from).toBe("A站Grok");
    expect(payload.details.target).toBe("A站负责人");
    expect(payload.details.hint_en).toContain("change the content or wait");
  });

  it("rounds the window display to whole minutes", () => {
    const payload = buildDuplicateSendPayload({
      from: "from-x",
      to: "to-y",
      ageMs: 0,
      windowMs: 90_000,
    });
    // 90 s rounds to 2 min for the human-readable hint.
    expect(payload.message).toContain("2 分钟内");
  });
});
