import { describe, expect, test } from "bun:test";
import { QUEUED_VARIANT_TTL_MS, queuedVariantExpired, shouldApplyQueuedVariant } from "./queued-variant";

// 这两条判据是「跑完再切」的实质：不在这时应用，那句话就还是安慰；
// 不设上界，用户几小时后会发现自己点过的档位突然生效（比直接拒绝更坏）。
describe("queued variant", () => {
  test("applies only when the turn really ended", () => {
    expect(shouldApplyQueuedVariant({ hasQueued: true, inFlight: 0, queuedAt: 1000, now: 2000 })).toBe(true);
    expect(shouldApplyQueuedVariant({ hasQueued: true, inFlight: 1, queuedAt: 1000, now: 2000 })).toBe(false);
    expect(shouldApplyQueuedVariant({ hasQueued: false, inFlight: 0, queuedAt: 1000, now: 2000 })).toBe(false);
  });

  test("expires after the ttl instead of surprising the user later", () => {
    const t0 = 5_000;
    expect(queuedVariantExpired(t0, t0 + QUEUED_VARIANT_TTL_MS)).toBe(false);
    expect(queuedVariantExpired(t0, t0 + QUEUED_VARIANT_TTL_MS + 1)).toBe(true);
    expect(shouldApplyQueuedVariant({ hasQueued: true, inFlight: 0, queuedAt: t0, now: t0 + QUEUED_VARIANT_TTL_MS + 1 })).toBe(false);
  });

  test("junk timestamps are treated as expired, never as fresh", () => {
    expect(queuedVariantExpired(Number.NaN, 1000)).toBe(true);
    expect(queuedVariantExpired(1000, Number.NaN)).toBe(true);
    expect(queuedVariantExpired(0, 1000)).toBe(true);
    expect(queuedVariantExpired(2000, 1000)).toBe(true);   // 时间倒流
    expect(shouldApplyQueuedVariant({ hasQueued: true, inFlight: 0, queuedAt: Number.NaN, now: 1000 })).toBe(false);
  });
});
