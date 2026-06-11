// #226 — public login brute-force guard.
// In-memory by design: zero dependency, process-local defence-in-depth for the
// public /api/auth/login surface. Bearer token auth paths do not use this file.

export const LOGIN_IP_WINDOW_MS = 60_000;
export const LOGIN_IP_MAX_PER_WINDOW = 10;
export const LOGIN_FAILURE_THRESHOLD = 5;
export const LOGIN_LOCK_BASE_MS = 30_000;
export const LOGIN_LOCK_MAX_MS = 15 * 60_000;

type WindowState = { count: number; resetAt: number };

export class LoginIpRateLimiter {
  private state = new Map<string, WindowState>();

  constructor(
    private readonly windowMs: number = LOGIN_IP_WINDOW_MS,
    private readonly maxPerWindow: number = LOGIN_IP_MAX_PER_WINDOW,
  ) {}

  check(key: string, nowMs: number = Date.now()): { allowed: boolean; remaining: number; resetAt: number; retryAfterMs?: number } {
    const entry = this.state.get(key);
    if (!entry || nowMs >= entry.resetAt) {
      const resetAt = nowMs + this.windowMs;
      this.state.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.maxPerWindow - 1, resetAt };
    }
    if (entry.count >= this.maxPerWindow) {
      return { allowed: false, remaining: 0, resetAt: entry.resetAt, retryAfterMs: entry.resetAt - nowMs };
    }
    entry.count++;
    return { allowed: true, remaining: this.maxPerWindow - entry.count, resetAt: entry.resetAt };
  }

  reset(): void {
    this.state.clear();
  }
}

type FailureState = { failures: number; lockedUntil: number };

export class LoginFailureLockout {
  private state = new Map<string, FailureState>();

  constructor(
    private readonly threshold: number = LOGIN_FAILURE_THRESHOLD,
    private readonly baseLockMs: number = LOGIN_LOCK_BASE_MS,
    private readonly maxLockMs: number = LOGIN_LOCK_MAX_MS,
  ) {}

  check(username: string, nowMs: number = Date.now()): { locked: boolean; retryAfterMs?: number; lockedUntil?: number } {
    const key = normalizeLoginUsername(username);
    if (!key) return { locked: false };
    const entry = this.state.get(key);
    if (!entry || !entry.lockedUntil || nowMs >= entry.lockedUntil) return { locked: false };
    return { locked: true, retryAfterMs: entry.lockedUntil - nowMs, lockedUntil: entry.lockedUntil };
  }

  recordFailure(username: string, nowMs: number = Date.now()): { locked: boolean; failures: number; lockMs?: number; lockedUntil?: number } {
    const key = normalizeLoginUsername(username);
    if (!key) return { locked: false, failures: 0 };
    const current = this.state.get(key);
    const failures = (current?.failures ?? 0) + 1;
    if (failures < this.threshold) {
      this.state.set(key, { failures, lockedUntil: 0 });
      return { locked: false, failures };
    }

    const exponent = failures - this.threshold;
    const lockMs = Math.min(this.baseLockMs * Math.pow(2, exponent), this.maxLockMs);
    const lockedUntil = nowMs + lockMs;
    this.state.set(key, { failures, lockedUntil });
    return { locked: true, failures, lockMs, lockedUntil };
  }

  recordSuccess(username: string): void {
    const key = normalizeLoginUsername(username);
    if (key) this.state.delete(key);
  }

  reset(): void {
    this.state.clear();
  }
}

export function normalizeLoginUsername(username: unknown): string {
  return typeof username === "string" ? username.trim().toLowerCase() : "";
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const sharedLoginIpRateLimiter = new LoginIpRateLimiter(
  envInt("COMMHUB_LOGIN_IP_WINDOW_MS", LOGIN_IP_WINDOW_MS),
  envInt("COMMHUB_LOGIN_IP_MAX", LOGIN_IP_MAX_PER_WINDOW),
);

export const sharedLoginFailureLockout = new LoginFailureLockout(
  envInt("COMMHUB_LOGIN_FAILURE_THRESHOLD", LOGIN_FAILURE_THRESHOLD),
  envInt("COMMHUB_LOGIN_LOCK_BASE_MS", LOGIN_LOCK_BASE_MS),
  envInt("COMMHUB_LOGIN_LOCK_MAX_MS", LOGIN_LOCK_MAX_MS),
);
