// RFC-025 M1d P1 — self-scoped loop management tools.
//
// Six handlers an agent calls to manage ITS OWN loops. No `alias`
// parameter — by construction the handlers only ever see the
// per-node goalStore instance, so an agent can NEVER address another
// node's goals (RFC-025 §5.2 safety invariant). claude-code-cli
// runtime is out of scope (RFC-025 §3.1 + §12): these tools are
// registered only in agent-node-spawned runtimes.
//
// Pure handler module — runtime-agnostic. The per-runtime MCP
// adapter (claude-agent-sdk in this same M1d / codex / grok in
// later milestones) consumes SELF_LOOP_TOOL_SPECS to register tools
// with each SDK's tool surface.

import { computeNextWakeAt } from "./schedule";
import { parseGoalCommand } from "./parser";
import { newGoal } from "./store";
import type { GoalStore } from "./store";
import type { AgentGoal, AgentGoalSchedule } from "./types";

// Safety constants per RFC-025 §7 (resolved decisions §11.5 + §11.7).
export const DEFAULT_MAX_ACTIVE_GOALS_PER_NODE = 20;
export const DEFAULT_COOLDOWN_MS = 30_000; // 30s per-goal anti-recursion
export const DEFAULT_BATCH_CANCEL_WINDOW_MS = 30_000;
export const DEFAULT_BATCH_CANCEL_THRESHOLD = 3; // 3 cancels in 30s → confirm-back

export interface SelfLoopCtx {
  store: GoalStore;
  /** Caller's runtime ("claude-agent-sdk" etc.) — written into new goals. */
  runtime: string;
  /** Node's default timezone for cron-lite schedules. RFC-025 §11.8 default Asia/Shanghai. */
  defaultTz: string;
  /** Env-overridable: max active goals before create_my_loop rejects. */
  maxActiveGoals?: number;
  /**
   * Recent cancel timestamps (in-memory, per-process). Tracks
   * cancel_my_loop call times for the confirm-back threshold. Caller
   * supplies + persists across handler calls; tools mutate in place.
   */
  recentCancels?: number[];
  /**
   * Recent batch-confirm tokens the agent has presented. When the
   * confirm-back path returns `error: 'batch_destructive_confirm_required'`
   * with a token, the agent re-calls with `confirm_token` set. The
   * tool checks the token here and proceeds if present.
   */
  pendingConfirmTokens?: Set<string>;
  /** Now provider — overridable for tests. Default Date.now(). */
  now?: () => number;
}

/** All handlers return this discriminated shape so MCP wire-up is uniform. */
export type SelfLoopResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; message: string; confirm_token?: string };

// ── helpers ──────────────────────────────────────────────────────────

function nowOf(ctx: SelfLoopCtx): number {
  return (ctx.now ?? Date.now)();
}

function withinCooldown(g: AgentGoal, now: number): boolean {
  const updated = Date.parse(g.updated_at);
  if (!Number.isFinite(updated)) return false;
  return now - updated < DEFAULT_COOLDOWN_MS;
}

function intervalFromText(intervalText: string): number {
  // Reuse #288 parser (60s floor, m/h/d units, etc.). We don't have
  // a separate "parse interval string" entry point in parser.ts,
  // so build a fake "/aloop <interval> x" and read interval_ms.
  const r = parseGoalCommand(`/aloop ${intervalText} x`);
  if (!r.ok) throw new Error(`invalid interval "${intervalText}": ${r.error}`);
  return r.goal.interval_ms;
}

function parseSchedule(
  schedule: any,
  intervalText: string | undefined,
  defaultTz: string,
): { interval_ms: number; schedule?: AgentGoalSchedule } {
  // Two shapes accepted: structured `schedule` arg (cron-lite) or
  // `interval` string (legacy/simple). At least one must be set.
  if (schedule && typeof schedule === "object") {
    if (schedule.type === "interval") {
      if (typeof schedule.interval_ms !== "number" || schedule.interval_ms < 60_000) {
        throw new Error("interval schedule needs interval_ms >= 60000");
      }
      return { interval_ms: schedule.interval_ms, schedule };
    }
    if (schedule.type === "time_of_day") {
      if (typeof schedule.time !== "string") throw new Error("time_of_day schedule needs time (HH:MM)");
      // Natural cadence = 24h
      return {
        interval_ms: 24 * 60 * 60_000,
        schedule: { type: "time_of_day", time: schedule.time, timezone: schedule.timezone || defaultTz },
      };
    }
    if (schedule.type === "weekday") {
      if (!Array.isArray(schedule.days) || schedule.days.length === 0) throw new Error("weekday schedule needs days[]");
      if (typeof schedule.time !== "string") throw new Error("weekday schedule needs time (HH:MM)");
      // Natural cadence = 7d
      return {
        interval_ms: 7 * 24 * 60 * 60_000,
        schedule: { type: "weekday", days: schedule.days, time: schedule.time, timezone: schedule.timezone || defaultTz },
      };
    }
    throw new Error(`unknown schedule type "${schedule.type}"`);
  }
  if (intervalText) {
    return { interval_ms: intervalFromText(intervalText) };
  }
  throw new Error("either 'schedule' (cron-lite) or 'interval' (string like '5m') required");
}

function ok(data: unknown): SelfLoopResult {
  return { ok: true, data };
}

function fail(error: string, message: string, confirm_token?: string): SelfLoopResult {
  return { ok: false, error, message, ...(confirm_token ? { confirm_token } : {}) };
}

// ── handlers (6 tools) ───────────────────────────────────────────────

export async function handleListMyLoops(_args: any, ctx: SelfLoopCtx): Promise<SelfLoopResult> {
  const goals = await ctx.store.list();
  return ok({
    goals: goals.map((g) => ({
      goal_id: g.goal_id,
      goal_id_short: g.goal_id.slice(0, 8),
      text: g.text,
      status: g.status,
      cadence: g.schedule ?? { type: "interval", interval_ms: g.interval_ms },
      next_wake_at: g.next_wake_at,
      last_wake_at: g.last_wake_at,
      last_report_at: g.last_report_at,
    })),
    total: goals.length,
  });
}

export async function handleCreateMyLoop(args: any, ctx: SelfLoopCtx): Promise<SelfLoopResult> {
  if (!args.task || typeof args.task !== "string" || !args.task.trim()) {
    return fail("invalid_args", "missing required 'task' (string)");
  }
  // Max-goals cap (RFC-025 §11.5)
  const max = ctx.maxActiveGoals ?? DEFAULT_MAX_ACTIVE_GOALS_PER_NODE;
  const goals = await ctx.store.list();
  const activeCount = goals.filter((g) => g.status === "active").length;
  if (activeCount >= max) {
    return fail(
      "max_active_goals_reached",
      `this node already has ${activeCount}/${max} active goals — cancel or complete some before creating new ones`
    );
  }
  let parsed: { interval_ms: number; schedule?: AgentGoalSchedule };
  try {
    parsed = parseSchedule(args.schedule, args.interval, ctx.defaultTz);
  } catch (e: any) {
    return fail("invalid_schedule", e.message);
  }
  // #302 round-2 (通信牛 catch): structured schedule shape may be
  // syntactically valid (time matches HH:MM, type is allowed) but
  // semantically broken — e.g. bogus IANA timezone "Bad/Zone" that
  // Intl.DateTimeFormat rejects. Without this preflight, such a
  // schedule lands in goals.json, then every scheduler tick throws
  // in computeNextWakeAt → goal stays active+due → self-lock wake
  // storm. Catch here BEFORE the write so the goal never reaches
  // disk and existing goals are untouched.
  try {
    computeNextWakeAt(parsed.schedule, new Date(nowOf(ctx)), ctx.defaultTz, {
      fallback_interval_ms: parsed.interval_ms,
    });
  } catch (e: any) {
    return fail("invalid_schedule", `schedule fails compute: ${e?.message || e}`);
  }
  const g = newGoal({
    text: args.task.trim(),
    interval_ms: parsed.interval_ms,
    schedule: parsed.schedule,
    default_tz: ctx.defaultTz,
    runtime: ctx.runtime,
  });
  await ctx.store.upsert(g);
  return ok({
    goal_id: g.goal_id,
    goal_id_short: g.goal_id.slice(0, 8),
    next_wake_at: g.next_wake_at,
    cadence: g.schedule ?? { type: "interval", interval_ms: g.interval_ms },
    // Per RFC-025 §3.2 #3: agent should report the new value back to user.
    message: `已创建循环 ${g.goal_id.slice(0, 8)}, 下次唤醒 ${g.next_wake_at}`,
  });
}

export async function handleEditMyLoop(args: any, ctx: SelfLoopCtx): Promise<SelfLoopResult> {
  if (!args.goal_id || typeof args.goal_id !== "string") {
    return fail("invalid_args", "missing required 'goal_id'");
  }
  const g = await ctx.store.get(args.goal_id);
  if (!g) return fail("goal_not_found", `no goal with id "${args.goal_id}"`);
  // Cooldown (RFC-025 §7.1 anti-recursion)
  const now = nowOf(ctx);
  if (withinCooldown(g, now)) {
    return fail(
      "cooldown",
      `goal was modified <30s ago (${g.updated_at}) — wait a moment before editing again`
    );
  }
  // Validate interval if changing
  let newIntervalMs: number | undefined;
  let newSchedule: AgentGoalSchedule | undefined | null = undefined;
  if (args.interval !== undefined || args.schedule !== undefined) {
    try {
      const parsed = parseSchedule(args.schedule, args.interval, ctx.defaultTz);
      newIntervalMs = parsed.interval_ms;
      newSchedule = parsed.schedule ?? null; // null = clear schedule field
    } catch (e: any) {
      return fail("invalid_schedule", e.message);
    }
    // #302 round-2 (通信牛 catch) — preflight computeNextWakeAt so a
    // semantically-bad-but-shape-valid schedule (e.g. invalid timezone)
    // is rejected BEFORE we overwrite the existing goal. Otherwise
    // edit + bad TZ corrupts the existing healthy goal into a
    // self-locking one.
    try {
      computeNextWakeAt(newSchedule ?? undefined, new Date(now), ctx.defaultTz, {
        fallback_interval_ms: newIntervalMs ?? g.interval_ms,
      });
    } catch (e: any) {
      return fail("invalid_schedule", `schedule fails compute: ${e?.message || e}`);
    }
  }
  const updated = await ctx.store.mutate(args.goal_id, (current) => {
    if (typeof args.task === "string" && args.task.trim()) current.text = args.task.trim();
    if (newIntervalMs !== undefined) current.interval_ms = newIntervalMs;
    if (newSchedule !== undefined) {
      if (newSchedule === null) delete (current as any).schedule;
      else current.schedule = newSchedule;
    }
    if (typeof args.paused === "boolean") {
      const wasPaused = current.status === "paused";
      current.status = args.paused ? "paused" : "active";
      // RFC-025 P0.3 — unpause resets the poison-goal counter so the
      // agent/operator gets a fresh 5-strike window after fixing the
      // root cause. Cancel side (args.paused=true) doesn't reset —
      // that's a manual pause; the counter should carry over if the
      // agent later re-un-pauses without addressing the failure.
      // Skip when we're setting paused=false BUT the goal wasn't
      // actually paused (no-op edit): don't wipe a legitimate mid-
      // failure counter of an already-active goal.
      if (!args.paused && wasPaused) {
        current.consecutive_failures = 0;
      }
    }
  });
  return ok({
    goal_id: updated!.goal_id,
    cadence: updated!.schedule ?? { type: "interval", interval_ms: updated!.interval_ms },
    status: updated!.status,
    text: updated!.text,
    message: `已更新循环 ${updated!.goal_id.slice(0, 8)}`,
  });
}

export async function handleRescheduleMyLoop(args: any, ctx: SelfLoopCtx): Promise<SelfLoopResult> {
  // ★ Claude Code /loop ScheduleWakeup 范式 (RFC-025 §5.1).
  // Doesn't change interval — only pushes next_wake_at one-shot.
  if (!args.goal_id || typeof args.goal_id !== "string") {
    return fail("invalid_args", "missing required 'goal_id'");
  }
  if (!args.next_wake_in || typeof args.next_wake_in !== "string") {
    return fail("invalid_args", "missing required 'next_wake_in' (e.g. '30m' / '2h' / '1d')");
  }
  const g = await ctx.store.get(args.goal_id);
  if (!g) return fail("goal_not_found", `no goal with id "${args.goal_id}"`);
  const now = nowOf(ctx);
  if (withinCooldown(g, now)) {
    return fail("cooldown", `goal modified <30s ago — wait before reschedule`);
  }
  let deltaMs: number;
  try {
    deltaMs = intervalFromText(args.next_wake_in);
  } catch (e: any) {
    return fail("invalid_interval", e.message);
  }
  const nextWake = new Date(now + deltaMs).toISOString();
  const updated = await ctx.store.mutate(args.goal_id, (current) => {
    current.next_wake_at = nextWake;
  });
  return ok({
    goal_id: updated!.goal_id,
    next_wake_at: updated!.next_wake_at,
    message: `已推迟 ${updated!.goal_id.slice(0, 8)} 下次唤醒到 ${nextWake} (本轮一次性, interval 不变)`,
  });
}

export async function handleCompleteMyLoop(args: any, ctx: SelfLoopCtx): Promise<SelfLoopResult> {
  // ★ 达标即停 (RFC-025 §5.1). 跟 cancel 语义分清: complete = goal
  // achieved, cancel = abandoned.
  if (!args.goal_id || typeof args.goal_id !== "string") {
    return fail("invalid_args", "missing required 'goal_id'");
  }
  const g = await ctx.store.get(args.goal_id);
  if (!g) return fail("goal_not_found", `no goal with id "${args.goal_id}"`);
  const updated = await ctx.store.setStatus(args.goal_id, "complete");
  return ok({
    goal_id: updated!.goal_id,
    status: updated!.status,
    message: `✓ 循环 ${updated!.goal_id.slice(0, 8)} 已达标完成 (status=complete)`,
  });
}

export async function handleCancelMyLoop(args: any, ctx: SelfLoopCtx): Promise<SelfLoopResult> {
  if (!args.goal_id || typeof args.goal_id !== "string") {
    return fail("invalid_args", "missing required 'goal_id'");
  }
  // Batch-cancel confirm-back (RFC-025 §3.2 #2)
  const now = nowOf(ctx);
  const recent = ctx.recentCancels ?? [];
  const windowStart = now - DEFAULT_BATCH_CANCEL_WINDOW_MS;
  // Prune old timestamps in place
  while (recent.length > 0 && recent[0] < windowStart) recent.shift();
  if (recent.length >= DEFAULT_BATCH_CANCEL_THRESHOLD && !args.confirm_token) {
    // Issue a confirm token. Agent must re-call with confirm_token to proceed.
    const token = `confirm-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    if (ctx.pendingConfirmTokens) ctx.pendingConfirmTokens.add(token);
    return fail(
      "batch_destructive_confirm_required",
      `已经取消了 ${recent.length} 个循环在过去 30 秒 — 这次取消需要用户确认才继续。回问用户是否真要取消这个 ${args.goal_id.slice(0, 8)}, 拿到确认后重新调本工具并传 confirm_token="${token}"`,
      token
    );
  }
  if (args.confirm_token && ctx.pendingConfirmTokens) {
    if (!ctx.pendingConfirmTokens.has(args.confirm_token)) {
      return fail("invalid_confirm_token", "confirm_token unknown or already used");
    }
    ctx.pendingConfirmTokens.delete(args.confirm_token);
  }
  const g = await ctx.store.get(args.goal_id);
  if (!g) return fail("goal_not_found", `no goal with id "${args.goal_id}"`);
  const updated = await ctx.store.setStatus(args.goal_id, "cancelled");
  // `recent` is the same array reference as ctx.recentCancels (when
  // caller passes one) — push mutates in place. No re-assignment.
  recent.push(now);
  return ok({
    goal_id: updated!.goal_id,
    status: updated!.status,
    message: `已取消循环 ${updated!.goal_id.slice(0, 8)} (status=cancelled, 不可恢复)`,
  });
}

// ── tool spec table for per-runtime adapters ─────────────────────────

export interface SelfLoopToolSpec {
  name: string;
  description: string;
  handler: (args: any, ctx: SelfLoopCtx) => Promise<SelfLoopResult>;
}

export const SELF_LOOP_TOOL_SPECS: SelfLoopToolSpec[] = [
  {
    name: "list_my_loops",
    description:
      "看自己当前所有循环 (active + paused 的). 用户提到「这个/那个/重要的那个」时先调本工具看清单再决定指代. 返回 {goals: [{goal_id, status, cadence, next_wake_at, text}], total}.",
    handler: handleListMyLoops,
  },
  {
    name: "create_my_loop",
    description:
      "新建一个循环任务. interval 用 '5m'/'2h'/'1d' (单字母 m/h/d); 或 schedule 用 cron-lite 联合 (interval/time_of_day '09:00'/weekday ['mon','wed','fri']+time). 用户没给具体数字时选合理值后**回报新值** ('已设成每 30 分钟一次') 让用户能纠正. 上限默认 20 个 active goals/节点 (满了拒).",
    handler: handleCreateMyLoop,
  },
  {
    name: "edit_my_loop",
    description:
      "改一个循环 (改 task / interval / schedule / paused). `paused=true` 是**临时**暂停, 后续 `paused=false` 可恢复 (不同于 cancel). 改 interval 后必**回报新值**给用户. 同一 goal 30s 内只能改 1 次 (防递归暴走).",
    handler: handleEditMyLoop,
  },
  {
    name: "reschedule_my_loop",
    description:
      "★ 动态自调度 — **不改 interval**, 只把本轮 next_wake 推到指定时刻. 用于「这次任务有进展但不急, 下次 1h 后再看」类场景. interval 仍按原节奏走. 类似 Claude Code /loop 的 ScheduleWakeup 范式. next_wake_in 用 '30m'/'2h'/'1d' 等.",
    handler: handleRescheduleMyLoop,
  },
  {
    name: "complete_my_loop",
    description:
      "★ 达标归档 — 任务目标已实现 (PR 已 merge / 报告交付 / etc.). status=`complete`. **不同于 cancel**: 这是成就归档, 不是放弃. agent 自决达标即停, 防死循环.",
    handler: handleCompleteMyLoop,
  },
  {
    name: "cancel_my_loop",
    description:
      "永久放弃一个循环 — 不再做这件事 (非达标). status=`cancelled`, 不可恢复. **不同于 pause/complete**: 这是放弃. 短时间内 (30s) 连续取消 3 个以上会触发 confirm-back: 工具返 error='batch_destructive_confirm_required' + confirm_token, agent 必须回问用户确认后带 confirm_token 重调.",
    handler: handleCancelMyLoop,
  },
];
