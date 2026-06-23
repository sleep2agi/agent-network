// Telegram plugin watchdog (#246).
//
// Background — see RFC-024 reframe + commhub conversation b7d6f516.
//
// The official `claude-plugins-official/telegram` plugin sometimes dies
// without auto-respawn (root cause still pending — intermittent). When it
// does, the node loses its bot.pid and Vincent's primary channel goes
// silent until a human restarts the node. This module watches for that
// failure mode and triggers a node restart, gated to avoid disrupting an
// actively-working agent or thrashing on a misconfigured node.
//
// Wired into `agent-node` only when `config.json` contains
// `telegram: { watchdog: true }` — opt-in, default off. Existing nodes
// see zero behavior change.

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

export interface TelegramWatchdogConfig {
  /** Plugin state directory containing `bot.pid` (from config.env.TELEGRAM_STATE_DIR). */
  stateDir: string;
  /** Own alias (so we can query our own commhub session and notify admin). */
  alias: string;
  /** CommHub base URL — same one the rest of agent-node uses. */
  commhubUrl: string;
  /** CommHub token (ntok_) — for /api/status query and send_message MCP. */
  commhubToken: string;

  /** Knobs — all default to the values reviewed with 通信龙. */
  /** How often to check poller liveness. Default 60 s. */
  pollIntervalMs?: number;
  /** Agent must be idle AND last-active-longer-than this before we'd restart
   *  on the idle path. Default 5 min — gives a buffer past brief lulls. */
  idleThresholdMs?: number;
  /** If poller has been dead this long, restart regardless of agent activity
   *  (fallback so a persistently-busy agent doesn't stay broken forever).
   *  Default 20 min — matches the observed pre-fix outage tolerance. */
  forceRestartAfterDeadMs?: number;
  /** Minimum gap between two consecutive restart fires. Default 30 min —
   *  caps thrash on misconfigured tokens / broken plugin. */
  thrashWindowMs?: number;
  /** Admin alias to notify before restarting. Default `通信龙`. */
  adminAlias?: string;
}

export interface TelegramWatchdogHandle {
  /** setInterval handle — call `clearInterval` to stop. Mostly for tests. */
  timer: NodeJS.Timeout;
}

const DEFAULTS = {
  pollIntervalMs: 60_000,
  idleThresholdMs: 5 * 60 * 1_000,
  forceRestartAfterDeadMs: 20 * 60 * 1_000,
  thrashWindowMs: 30 * 60 * 1_000,
  adminAlias: "通信龙",
};

function expandHome(p: string): string {
  if (!p) return p;
  return p.startsWith("~") ? p.replace(/^~/, homedir()) : p;
}

function parseSqliteIsoTimestamp(ts: string | undefined | null): number | null {
  // commhub `updated_at` is `'YYYY-MM-DD HH:MM:SS'` (UTC, no tz suffix).
  // `Date.parse` is permissive enough but unreliable on the space-as-separator
  // form across engines; do it explicitly.
  if (!ts) return null;
  const fixed = ts.includes("T") ? ts : ts.replace(" ", "T") + "Z";
  const ms = Date.parse(fixed);
  return Number.isFinite(ms) ? ms : null;
}

export function startTelegramWatchdog(
  cfg: TelegramWatchdogConfig,
  log: (msg: string) => void,
): TelegramWatchdogHandle {
  const POLL = cfg.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const IDLE = cfg.idleThresholdMs ?? DEFAULTS.idleThresholdMs;
  const FORCE_AFTER = cfg.forceRestartAfterDeadMs ?? DEFAULTS.forceRestartAfterDeadMs;
  const THRASH = cfg.thrashWindowMs ?? DEFAULTS.thrashWindowMs;
  const ADMIN = cfg.adminAlias ?? DEFAULTS.adminAlias;

  const PID_FILE = `${expandHome(cfg.stateDir)}/bot.pid`;

  let deadSinceMs = 0;
  let lastRestartMs = 0;
  // Re-entrancy guard — if a previous tick is still awaiting the
  // 10 s pre-restart grace, skip this tick to avoid overlapping
  // restart fires (defensive; timing makes it unlikely but cheap).
  let ticking = false;

  const pollerAlive = (): boolean => {
    if (!existsSync(PID_FILE)) return false;
    try {
      const pid = parseInt(readFileSync(PID_FILE, "utf8"), 10);
      if (!Number.isFinite(pid) || pid <= 1) return false;
      // signal 0 = existence check, doesn't actually deliver a signal
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const queryOwnSessionStatus = async (): Promise<{
    status: string;
    lastSeenMs: number | null;
  } | null> => {
    try {
      const res = await fetch(`${cfg.commhubUrl}/api/status?light=1`, {
        headers: { Authorization: `Bearer ${cfg.commhubToken}` },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        sessions?: Array<{ alias: string; status: string; updated_at?: string }>;
      };
      const own = (data.sessions ?? []).find((s) => s.alias === cfg.alias);
      if (!own) return null;
      return {
        status: own.status ?? "unknown",
        lastSeenMs: parseSqliteIsoTimestamp(own.updated_at),
      };
    } catch {
      return null;
    }
  };

  const sendAdminMessage = async (text: string): Promise<void> => {
    try {
      await fetch(`${cfg.commhubUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.commhubToken}`,
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: {
            name: "send_message",
            arguments: {
              alias: ADMIN,
              message: `[telegram-watchdog] ${cfg.alias}: ${text}`,
            },
          },
        }),
      });
    } catch (e: any) {
      log(`admin notify failed: ${e?.message ?? String(e)}`);
    }
  };

  const fireRestart = async (reason: string): Promise<void> => {
    log(`triggering restart — reason: ${reason}`);
    await sendAdminMessage(`telegram poller down, restarting in 10s (${reason})`);
    // Give downstream a beat to notice the notification, then detach a child
    // session that will outlive the imminent `anet node stop` of ourselves.
    await new Promise((r) => setTimeout(r, 10_000));

    // `setsid` puts the helper in its own session so the parent kill chain
    // can't reach it. `nohup` would also work but `setsid` is cleaner about
    // tty detachment and matches the pattern used for other anet helpers.
    //
    // `--accept-dev-channels` is REQUIRED here (#176). Default `anet node
    // start` runs claude in foreground and hangs on the dev-channels
    // confirmation prompt waiting for an Enter that nobody can press in
    // this detached/headless context. The flag spawns claude in a detached
    // tmux session (so it gets a PTY) and auto-confirms the prompt via
    // the same side-channel that `anet project up` uses. Without it the
    // restart would deadlock and the watchdog would make the outage
    // worse, not better — per 通信龙 a4d1836b code-review catch.
    const cmd =
      `setsid sh -c 'sleep 5 && ` +
      `anet node stop ${JSON.stringify(cfg.alias)} >> /tmp/telegram-watchdog-${cfg.alias}.log 2>&1 && ` +
      `sleep 2 && ` +
      `anet node start ${JSON.stringify(cfg.alias)} --accept-dev-channels >> /tmp/telegram-watchdog-${cfg.alias}.log 2>&1` +
      `' >> /tmp/telegram-watchdog-${cfg.alias}.log 2>&1 < /dev/null &`;

    const child = spawn("bash", ["-c", cmd], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    lastRestartMs = Date.now();
    // Reset death tracker so a slow-to-fire restart doesn't double-trigger
    // before this agent-node is actually killed.
    deadSinceMs = 0;
  };

  const tick = async (): Promise<void> => {
    if (ticking) {
      log("tick skipped — previous tick still in flight (pre-restart grace)");
      return;
    }
    ticking = true;
    try {
      await tickInner();
    } finally {
      ticking = false;
    }
  };

  const tickInner = async (): Promise<void> => {
    const now = Date.now();

    if (pollerAlive()) {
      if (deadSinceMs > 0) {
        log(`poller back alive (was down ${Math.round((now - deadSinceMs) / 1_000)}s)`);
      }
      deadSinceMs = 0;
      return;
    }

    // poller dead
    if (!deadSinceMs) {
      deadSinceMs = now;
      log(`poller DEAD detected (bot.pid missing or pid not alive)`);
      return;
    }

    // thrash cap — don't fire another restart inside the window
    if (lastRestartMs && now - lastRestartMs < THRASH) {
      const waitMin = Math.round((THRASH - (now - lastRestartMs)) / 60_000);
      log(`thrash cap held — next restart allowed in ${waitMin} min`);
      return;
    }

    const deadFor = now - deadSinceMs;
    const own = await queryOwnSessionStatus();

    // Idle-gate path: agent is idle AND was idle long enough that we're not
    // interrupting a mid-task pause.
    const isIdle = own?.status === "idle";
    const idleLongEnough = own?.lastSeenMs ? now - own.lastSeenMs > IDLE : false;

    if (isIdle && idleLongEnough) {
      const idleMin = own?.lastSeenMs
        ? Math.round((now - own.lastSeenMs) / 60_000)
        : null;
      await fireRestart(
        `idle path (status=idle, last activity ~${idleMin ?? "?"} min ago)`,
      );
      return;
    }

    // Fallback path: dead long enough that even an actively-working agent
    // is better off with telegram restored. Agents typically have natural
    // turn boundaries; restart pain (~30 s) is better than indefinitely
    // dead telegram on an active node.
    if (deadFor > FORCE_AFTER) {
      const deadMin = Math.round(deadFor / 60_000);
      await fireRestart(`force path (dead ${deadMin} min, agent active or status unknown)`);
      return;
    }

    log(
      `waiting — dead for ${Math.round(deadFor / 60_000)} min, ` +
        `status=${own?.status ?? "unknown"}, ` +
        `last_seen=${own?.lastSeenMs ? Math.round((now - own.lastSeenMs) / 60_000) + "min ago" : "?"}`,
    );
  };

  log(
    `started — poll=${POLL / 1_000}s, idle_threshold=${IDLE / 60_000}min, ` +
      `force_after=${FORCE_AFTER / 60_000}min, thrash_cap=${THRASH / 60_000}min, ` +
      `state_dir=${cfg.stateDir}`,
  );

  const timer = setInterval(() => {
    tick().catch((e) => log(`tick error: ${e?.message ?? String(e)}`));
  }, POLL);
  return { timer };
}
