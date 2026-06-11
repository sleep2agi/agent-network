import { describe, expect, test } from "bun:test";
import {
  LOGIN_FAILURE_THRESHOLD,
  LOGIN_LOCK_BASE_MS,
  LOGIN_LOCK_MAX_MS,
  LOGIN_IP_MAX_PER_WINDOW,
  LOGIN_IP_WINDOW_MS,
  LoginFailureLockout,
  LoginIpRateLimiter,
  normalizeLoginUsername,
} from "./auth_login_guard";

describe("LoginIpRateLimiter", () => {
  test("allows the first N attempts and blocks N+1 within the window", () => {
    const lim = new LoginIpRateLimiter(60_000, 3);
    expect(lim.check("203.0.113.10", 1000).allowed).toBe(true);
    expect(lim.check("203.0.113.10", 1001).allowed).toBe(true);
    expect(lim.check("203.0.113.10", 1002).allowed).toBe(true);
    const blocked = lim.check("203.0.113.10", 1003);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test("default public IP limit is 10/min", () => {
    expect(LOGIN_IP_WINDOW_MS).toBe(60_000);
    expect(LOGIN_IP_MAX_PER_WINDOW).toBe(10);
  });
});

describe("LoginFailureLockout", () => {
  test("locks on the fifth failure and doubles subsequent lock durations", () => {
    const lockout = new LoginFailureLockout(5, 30_000, 900_000);
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 4; i++) {
      const r = lockout.recordFailure("Alice", t0 + i);
      expect(r.locked).toBe(false);
      expect(r.failures).toBe(i + 1);
    }

    const first = lockout.recordFailure(" alice ", t0 + 5);
    expect(first.locked).toBe(true);
    expect(first.lockMs).toBe(30_000);
    expect(lockout.check("ALICE", t0 + 6).locked).toBe(true);

    const second = lockout.recordFailure("alice", t0 + 30_006);
    expect(second.locked).toBe(true);
    expect(second.lockMs).toBe(60_000);
  });

  test("caps exponential lock duration and success clears failure state", () => {
    const lockout = new LoginFailureLockout(2, 1000, 4000);
    const t0 = 10_000;
    expect(lockout.recordFailure("bob", t0).locked).toBe(false);
    expect(lockout.recordFailure("bob", t0 + 1).lockMs).toBe(1000);
    expect(lockout.recordFailure("bob", t0 + 1001).lockMs).toBe(2000);
    expect(lockout.recordFailure("bob", t0 + 3002).lockMs).toBe(4000);
    expect(lockout.recordFailure("bob", t0 + 7003).lockMs).toBe(4000);

    lockout.recordSuccess("bob");
    expect(lockout.check("bob", t0 + 7004).locked).toBe(false);
    expect(lockout.recordFailure("bob", t0 + 7005).locked).toBe(false);
  });

  test("default failure policy is 5 failures, 30s base, 15min cap", () => {
    expect(LOGIN_FAILURE_THRESHOLD).toBe(5);
    expect(LOGIN_LOCK_BASE_MS).toBe(30_000);
    expect(LOGIN_LOCK_MAX_MS).toBe(15 * 60_000);
  });
});

describe("normalizeLoginUsername", () => {
  test("normalizes for case-insensitive lockout keys", () => {
    expect(normalizeLoginUsername(" Alice ")).toBe("alice");
    expect(normalizeLoginUsername(undefined)).toBe("");
  });
});
