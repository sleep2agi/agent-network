import { describe, expect, test } from "bun:test";
import {
  LOGIN_FAILURE_THRESHOLD,
  LOGIN_LOCK_BASE_MS,
  LOGIN_LOCK_MAX_MS,
  LOGIN_IP_MAX_PER_WINDOW,
  LOGIN_IP_WINDOW_MS,
  getLoginClientIp,
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

  test("evicts expired entries before enforcing the cap", () => {
    const lim = new LoginIpRateLimiter(100, 10, 2);
    expect(lim.check("192.0.2.1", 0).allowed).toBe(true);
    expect(lim.check("192.0.2.2", 0).allowed).toBe(true);
    expect(lim.check("192.0.2.3", 101).allowed).toBe(true);

    expect(lim.check("192.0.2.1", 102).remaining).toBe(9);
  });

  test("evicts the oldest active entry when the cap is full", () => {
    const lim = new LoginIpRateLimiter(60_000, 1, 2);
    expect(lim.check("192.0.2.1", 0).allowed).toBe(true);
    expect(lim.check("192.0.2.2", 1).allowed).toBe(true);
    expect(lim.check("192.0.2.3", 2).allowed).toBe(true);

    expect(lim.check("192.0.2.1", 3).allowed).toBe(true);
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

  test("evicts expired failure entries before enforcing the cap", () => {
    const lockout = new LoginFailureLockout(2, 100, 1000, 2);
    expect(lockout.recordFailure("alice", 0).locked).toBe(false);
    expect(lockout.recordFailure("bob", 0).locked).toBe(false);
    expect(lockout.recordFailure("carol", 1).locked).toBe(false);

    expect(lockout.recordFailure("alice", 2).locked).toBe(false);
  });

  test("evicts the oldest active failure entry when the cap is full", () => {
    const lockout = new LoginFailureLockout(2, 1000, 1000, 2);
    expect(lockout.recordFailure("alice", 0).locked).toBe(false);
    expect(lockout.recordFailure("bob", 1).locked).toBe(false);
    expect(lockout.recordFailure("carol", 2).locked).toBe(false);

    expect(lockout.recordFailure("alice", 3).locked).toBe(false);
  });
});

describe("normalizeLoginUsername", () => {
  test("normalizes for case-insensitive lockout keys", () => {
    expect(normalizeLoginUsername(" Alice ")).toBe("alice");
    expect(normalizeLoginUsername(undefined)).toBe("");
  });
});

describe("getLoginClientIp", () => {
  test("uses the last x-forwarded-for hop so spoofed first hops do not bypass login rate limits", () => {
    const req = new Request("http://127.0.0.1/api/auth/login", {
      headers: { "x-forwarded-for": "198.51.100.99, 203.0.113.10" },
    });
    expect(getLoginClientIp(req)).toBe("203.0.113.10");
  });

  test("falls back to x-real-ip, then unknown", () => {
    const withRealIp = new Request("http://127.0.0.1/api/auth/login", {
      headers: { "x-real-ip": "203.0.113.20" },
    });
    expect(getLoginClientIp(withRealIp)).toBe("203.0.113.20");
    expect(getLoginClientIp(new Request("http://127.0.0.1/api/auth/login"))).toBe("unknown");
  });
});
