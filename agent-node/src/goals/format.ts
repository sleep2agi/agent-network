// RFC-025 M1c P0b — context-injection formatter.
//
// Pure renderer: turns the agent's active+paused goals into a
// human-readable block that gets prepended to every think() prompt
// so the agent knows "I'm currently looping these things".
//
// **Why prepend to user prompt** (not system prompt as the RFC §11.4
// resolution prefers): in practice codex-sdk and grok-build-acp don't
// expose a clean per-call systemPrompt slot the way claude-agent-sdk
// does. A user-prompt preamble with a `【...】` marker is the most
// uniform cross-runtime path and reads as "system-style metadata" to
// every LLM. We can refactor to per-runtime systemPrompt in a future
// pass if telemetry shows it matters.
//
// Pure function — no I/O, callable from anywhere.

import type { AgentGoal } from "./types";

export interface FormatOpts {
  /** Cap the block at N goals so it doesn't dominate the prompt. Default 20. */
  maxGoals?: number;
  /** Hide block entirely when there are no active+paused goals. Default true. */
  omitWhenEmpty?: boolean;
}

/**
 * Render a `【你的当前循环任务】` block listing this agent's active and
 * paused loops. Empty list → empty string (caller can prepend nothing).
 */
export function formatSelfLoopsBlock(goals: AgentGoal[], opts: FormatOpts = {}): string {
  const max = opts.maxGoals ?? 20;
  const omitWhenEmpty = opts.omitWhenEmpty ?? true;

  // Only active + paused are interesting context. Complete/cancelled/
  // failed are terminal — agent doesn't need them in working memory.
  const relevant = goals.filter((g) => g.status === "active" || g.status === "paused");

  if (relevant.length === 0 && omitWhenEmpty) return "";

  const lines: string[] = [];
  lines.push("【你的当前循环任务】 (anet goals — 用 manage_my_loop 工具管理)");
  lines.push("");

  if (relevant.length === 0) {
    lines.push("(无活跃循环)");
    return lines.join("\n") + "\n";
  }

  const shown = relevant.slice(0, max);
  for (const g of shown) {
    const id8 = g.goal_id.slice(0, 8);
    const status = g.status === "paused" ? "paused" : "active";
    const cadence = describeCadence(g);
    const nextTime = formatRelativeTime(g.next_wake_at);
    lines.push(`${id8}  ${status.padEnd(7)}  ${cadence.padEnd(20)}  下次: ${nextTime}`);
    const oneLineText = g.text.replace(/\s+/g, " ").trim().slice(0, 100);
    lines.push(`    ${oneLineText}`);
  }

  if (relevant.length > max) {
    lines.push(`... (+${relevant.length - max} 个更多, list_my_loops 看全部)`);
  }

  return lines.join("\n") + "\n";
}

function describeCadence(g: AgentGoal): string {
  if (g.schedule) {
    switch (g.schedule.type) {
      case "interval":
        return `每 ${humanizeMs(g.schedule.interval_ms)}`;
      case "time_of_day":
        return `每天 ${g.schedule.time}${g.schedule.timezone ? ` (${g.schedule.timezone})` : ""}`;
      case "weekday":
        return `${g.schedule.days.join("/")} ${g.schedule.time}`;
    }
  }
  return `每 ${humanizeMs(g.interval_ms)}`;
}

function humanizeMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}秒`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}min`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / 3600_000)}h`;
  return `${Math.round(ms / (24 * 3600_000))}d`;
}

function formatRelativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return iso;
    const delta = d.getTime() - Date.now();
    if (delta < 0) return `已到期 (${iso.slice(11, 19)}Z)`;
    if (delta < 60_000) return `~${Math.round(delta / 1000)}s 后`;
    if (delta < 60 * 60_000) return `~${Math.round(delta / 60_000)}min 后`;
    if (delta < 24 * 60 * 60_000) return `~${Math.round(delta / 3600_000)}h 后`;
    return iso.slice(0, 16).replace("T", " ");
  } catch {
    return iso;
  }
}
