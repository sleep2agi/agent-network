// #226 — public login brute-force guard.
// In-memory by design: zero dependency, process-local defence-in-depth for the
// public /api/auth/login surface. Bearer token auth paths do not use this file.

export const LOGIN_IP_WINDOW_MS = 60_000;
export const LOGIN_IP_MAX_PER_WINDOW = 10;
export const LOGIN_FAILURE_THRESHOLD = 5;
export const LOGIN_LOCK_BASE_MS = 30_000;
export const LOGIN_LOCK_MAX_MS = 15 * 60_000;
export const LOGIN_GUARD_MAX_ENTRIES = 50_000;

type WindowState = { count: number; resetAt: number };

export class LoginIpRateLimiter {
  private state = new Map<string, WindowState>();

  constructor(
    private readonly windowMs: number = LOGIN_IP_WINDOW_MS,
    private readonly maxPerWindow: number = LOGIN_IP_MAX_PER_WINDOW,
    private readonly maxEntries: number = LOGIN_GUARD_MAX_ENTRIES,
  ) {}

  check(key: string, nowMs: number = Date.now()): { allowed: boolean; remaining: number; resetAt: number; retryAfterMs?: number } {
    if (this.state.size >= this.maxEntries && !this.state.has(key)) {
      pruneExpired(this.state, nowMs, (entry) => nowMs >= entry.resetAt);
      evictOldestUntilBelowCap(this.state, this.maxEntries);
    }
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
    private readonly maxEntries: number = LOGIN_GUARD_MAX_ENTRIES,
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
    if (this.state.size >= this.maxEntries && !this.state.has(key)) {
      pruneExpired(this.state, nowMs, (entry) => !entry.lockedUntil || nowMs >= entry.lockedUntil);
      evictOldestUntilBelowCap(this.state, this.maxEntries);
    }
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

/**
 * COMMHUB_TRUSTED_PROXY_IPS（逗号分隔）—— 只有从这些地址连进来的请求，才信它带的 X-Forwarded-For / X-Real-IP。
 * 不设 = 旧行为（谁带都信），其它部署不受影响。设了以后，直连 Hub 端口的请求（对端不在名单里）
 * 一律按对端地址限速：伪造 X-Forwarded-For 绕不过登录 / 注册的按 IP 限速（2026-11-11 安全排查）。
 */
export function trustedProxyIps(env: Record<string, string | undefined> = process.env): Set<string> | null {
  const raw = env.COMMHUB_TRUSTED_PROXY_IPS?.trim();
  if (!raw) return null;
  return new Set(raw.split(",").map(s => normalizePeerIp(s.trim())).filter(Boolean));
}

/** `::ffff:1.2.3.4` → `1.2.3.4`（Bun 对 IPv4 连接常给映射地址）。 */
export function normalizePeerIp(ip: string | null | undefined): string {
  const v = (ip ?? "").trim();
  return v.toLowerCase().startsWith("::ffff:") ? v.slice(7) : v;
}

export function getLoginClientIp(req: Request, peer?: string | null, trusted: Set<string> | null = trustedProxyIps()): string {
  const direct = normalizePeerIp(peer);
  if (trusted && direct && !trusted.has(direct)) return direct;
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const last = fwd.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
    if (last) return last;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function pruneExpired<T>(map: Map<string, T>, nowMs: number, expired: (entry: T, nowMs: number) => boolean): void {
  for (const [key, entry] of map) {
    if (expired(entry, nowMs)) map.delete(key);
  }
}

function evictOldestUntilBelowCap<T>(map: Map<string, T>, maxEntries: number): void {
  while (map.size >= maxEntries) {
    const oldest = map.keys().next().value as string | undefined;
    if (!oldest) return;
    map.delete(oldest);
  }
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
  envInt("COMMHUB_LOGIN_GUARD_MAX_ENTRIES", LOGIN_GUARD_MAX_ENTRIES),
);

export const sharedLoginFailureLockout = new LoginFailureLockout(
  envInt("COMMHUB_LOGIN_FAILURE_THRESHOLD", LOGIN_FAILURE_THRESHOLD),
  envInt("COMMHUB_LOGIN_LOCK_BASE_MS", LOGIN_LOCK_BASE_MS),
  envInt("COMMHUB_LOGIN_LOCK_MAX_MS", LOGIN_LOCK_MAX_MS),
  envInt("COMMHUB_LOGIN_GUARD_MAX_ENTRIES", LOGIN_GUARD_MAX_ENTRIES),
);
