/**
 * #594 step 1 — report "this node shares one codex login with N other nodes on
 * this host" to the Hub, so the app can say it instead of the node log.
 *
 * #1918 already detects the condition (`checkCodexCredentialSharing`, host-wide
 * index of published 8-hex refresh-token fingerprints) but only prints a
 * warning into the node's own log at start-up — where nobody looks until tasks
 * start failing days later. This module turns the same check into one additive
 * field on the existing #448 health channel: `report_status.health.codex_login`.
 *
 * What "shared login" means here, precisely: two nodes hold the SAME refresh
 * token (same chain), not merely the same account. Same account with two
 * separate logins is fine — each node has its own refresh chain and neither can
 * revoke the other (see the header of `codex-auth-fingerprint.ts`).
 *
 * 🔴 What leaves this process: the 8-hex truncated sha256 of the refresh token
 *    (already written to disk by #1918 and printed by `anet node codex
 *    login-status`), two counts, and this node's own CODEX_HOME path (so a
 *    client can show the exact fix command). Never a token, never another
 *    node's alias or path — those may belong to a different network/user on the
 *    same machine, and the Hub would show them to this node's viewers.
 *
 * 🔴 Recomputed (rate-limited), not computed once. A node that starts FIRST
 *    sees nobody in the index; only the second one would ever report
 *    `shared_with: 1` if this were a start-up snapshot. Recomputing also keeps
 *    the published record current after codex refreshes in place.
 *    The trade-off is documented, not hidden: once one holder refreshes, the
 *    chains diverge and both counts drop to 0 — while the other holder is now
 *    revoked. That state is reported by the existing `health.model_auth`
 *    ("revoked"), which is the right layer for it.
 *
 * Never throws: observability must not be the reason a node stops.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkCodexCredentialSharing, fingerprintRefreshToken, type NodeFingerprint } from "./codex-auth-fingerprint.js";

/** Shape sent as `report_status.health.codex_login`. Additive; old Hubs drop it. */
export interface CodexLoginHealth {
  /** sha256(refresh_token) truncated to 8 hex — identifies a credential chain, not a credential. */
  fingerprint: string;
  /** Other nodes on this host currently publishing the same fingerprint. */
  shared_with: number;
  /** Of those, how many point at the very same CODEX_HOME directory. Different fix:
   *  re-logging in there would overwrite the neighbours' login too. */
  shared_home_with: number;
  /** This node's own CODEX_HOME, so the client can print
   *  `CODEX_HOME=<codex_home> codex login --device-auth`. */
  codex_home: string;
}

export interface CodexLoginHealthOptions {
  readonly nodeDir: string;
  readonly alias: string;
  readonly codexHome: string;
  readonly nodeId?: string | null;
  /** Where #1918's warning lines go. Printed on the first check and again only
   *  when the set of colliding nodes changes — not on every heartbeat. */
  readonly say?: (message: string) => void;
  /** Minimum gap between recomputations. Default 60 s. */
  readonly minIntervalMs?: number;
  /** Injected for tests. */
  readonly indexDir?: string;
  readonly now?: () => number;
}

export function createCodexLoginHealth(opts: CodexLoginHealthOptions) {
  const minInterval = opts.minIntervalMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let cached: CodexLoginHealth | null = null;
  let computedAt = -Infinity;
  let lastCollisionKey: string | null = null;

  function compute(): CodexLoginHealth | null {
    let fingerprint: string | null = null;
    try {
      fingerprint = fingerprintRefreshToken(readFileSync(join(opts.codexHome, "auth.json"), "utf-8"));
    } catch {
      fingerprint = null;
    }
    if (!fingerprint) {
      lastCollisionKey = null;
      return null;
    }
    // Buffer the warning lines and print them only when the collision set
    // changed, so a 3-minute heartbeat does not repeat a 6-line warning.
    const lines: string[] = [];
    let colliding: NodeFingerprint[] = [];
    try {
      colliding = checkCodexCredentialSharing({
        nodeDir: opts.nodeDir,
        alias: opts.alias,
        codexHome: opts.codexHome,
        nodeId: opts.nodeId ?? null,
        say: (m) => lines.push(m),
        now: new Date(now()),
        ...(opts.indexDir ? { indexDir: opts.indexDir } : {}),
      });
    } catch {
      colliding = [];
    }
    const key = `${fingerprint}|${colliding.map((c) => c.nodeDir ?? c.alias).sort().join(",")}`;
    if (key !== lastCollisionKey) {
      lastCollisionKey = key;
      const say = opts.say ?? ((m: string) => console.error(m));
      for (const line of lines) say(line);
    }
    const sameHome = colliding.filter((c) => typeof c.codexHome === "string" && c.codexHome === opts.codexHome).length;
    return {
      fingerprint,
      shared_with: colliding.length,
      shared_home_with: sameHome,
      codex_home: opts.codexHome,
    };
  }

  return {
    /** Recompute now (start-up), regardless of the rate limit. */
    refresh(): CodexLoginHealth | null {
      try { cached = compute(); } catch { cached = null; }
      computedAt = now();
      return cached;
    },
    /** Latest value, recomputed at most once per `minIntervalMs`. */
    current(): CodexLoginHealth | null {
      if (now() - computedAt >= minInterval) return this.refresh();
      return cached;
    },
    /** Recompute now; true when what would be reported changed (so the caller
     *  can push one report instead of waiting for the 3-minute heartbeat). */
    tick(): boolean {
      const before = JSON.stringify(cached);
      return JSON.stringify(this.refresh()) !== before;
    },
  };
}

/** Recheck interval: default 60 s; `ANET_CODEX_LOGIN_CHECK_INTERVAL_MS` (≥ 1000, for tests). */
export function codexLoginCheckIntervalFromEnv(env: NodeJS.ProcessEnv): number {
  const n = Number(env.ANET_CODEX_LOGIN_CHECK_INTERVAL_MS);
  return Number.isInteger(n) && n >= 1_000 ? n : 60_000;
}
