import { readFileSync } from "fs";
import type { Page, BrowserContext } from "@playwright/test";

// State written by run-e2e.sh — utok_, ntok_, network_id, alias.
export interface TestState {
  username: string;
  password: string;
  utok: string;
  ntok: string;
  network_id: string;
  user_id: string;
  alias: string;
}

export function loadState(): TestState {
  const raw = readFileSync("/tests/test-state.json", "utf-8");
  return JSON.parse(raw);
}

export const HUB_URL = process.env.HUB_URL || "http://hub:9200";
export const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://dashboard:3000";

/**
 * Drop a logged-in dashboard session straight into the browser by
 * setting the `anet_dashboard_session` cookie + the sessionStorage
 * record the React app reads on boot.
 *
 * Avoids re-typing creds in every test (and avoids tripping the hub's
 * rate limiter which kicks in at ~10 logins / 5min per IP).
 */
export async function loginAs(context: BrowserContext, page: Page, state: TestState) {
  // Cookie that NextJS server-side route handlers read.
  await context.addCookies([
    {
      name: "anet_dashboard_session",
      value: `v3:${state.utok}`,
      domain: "dashboard",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  // Pre-seed sessionStorage so the React app skips the login redirect.
  await page.addInitScript((payload) => {
    try {
      sessionStorage.setItem("anet_v3_auth", JSON.stringify(payload));
    } catch {}
  }, {
    user: { user_id: state.user_id, username: state.username, role: "admin" },
    token: state.utok,
    networks: [{ network_id: state.network_id, network_name: "default" }],
    currentNetwork: state.network_id,
  });
}

/** Poll an async predicate until it returns truthy or timeout fires. */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, opts: { timeout?: number; interval?: number; label?: string } = {}): Promise<T> {
  const timeout = opts.timeout ?? 30_000;
  const interval = opts.interval ?? 500;
  const start = Date.now();
  let last: any = null;
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v as T;
      last = v;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${timeout}ms (${opts.label || "no label"}). last=${JSON.stringify(last)?.slice(0, 200)}`);
}

/** Hit the hub's REST API directly (bypasses dashboard) using the user's utok_. */
export async function hubGet(state: TestState, path: string) {
  const res = await fetch(`${HUB_URL}${path}`, {
    headers: { Authorization: `Bearer ${state.utok}` },
  });
  if (!res.ok) throw new Error(`hubGet ${path} → ${res.status}`);
  return res.json();
}
