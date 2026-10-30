import { resolveTimeoutMs, type TimeoutResolveResult } from "../util/timeout";

/**
 * Default opencode task deadline. Agentic coding tasks routinely run a
 * clone + build + test cycle that outlasts 5 minutes; the old hard-coded
 * 300s made the copresence bridge report a failure while the turn kept
 * running in the TUI. 30 min covers a cold docker build plus a test run and
 * still bounds a wedged turn; `0` disables it.
 */
export const OPENCODE_DEFAULT_TASK_TIMEOUT_MS = 30 * 60_000;

/**
 * #3103 —— 排队（admission）阶段单独的上限。
 *
 * 共享会话被别人（TUI 里的一轮）占着时，网关只能等它空闲；等多久都不会更快。
 * 但在「一个总预算」的模型里，这段等待会吃掉回复阶段的时间：一条 30 分钟的任务
 * 若排队 29 分钟才提交，回复只剩 1 分钟，于是「执行了但回复被撤」。
 *
 * 所以给排队一个独立的上限：超过就明确告知「排队没排上、任务未提交」，
 * 而不是让它悄悄吃掉回复预算。总时长仍然有界（≤ budget），
 * 不会回到「每阶段各拿一整份、一条任务占 2×budget」的旧形态。
 * `0` = 不额外设限，保持单个总预算的现状。
 */
export const OPENCODE_DEFAULT_ADMISSION_CAP_MS = 10 * 60_000;

export interface OpencodeTimeoutResolution extends TimeoutResolveResult {
  /** Which knob won, for the startup log line. */
  sourceLabel: string;
}

function flagNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/**
 * Task deadline for the opencode runtime (copresence: wall-clock budget per
 * network task; headless ACP: idle budget between protocol frames).
 *
 * Precedence mirrors claude/codex: env `OPENCODE_TIMEOUT_MS` > RFC-024
 * canonical `flags.timeout` (the key the Dashboard edits, so a Dashboard
 * change is never shadowed) > runtime-specific `flags.opencodeTimeoutMs` >
 * default 30 min. `0` disables the deadline; negative / non-numeric values
 * fall through to the next source.
 */
export function resolveOpencodeTimeout(input: {
  env?: string | undefined;
  flags?: { timeout?: unknown; opencodeTimeoutMs?: unknown } | undefined;
}): OpencodeTimeoutResolution {
  const canonical = flagNumber(input.flags?.timeout);
  const specific = flagNumber(input.flags?.opencodeTimeoutMs);
  const canonicalUsable = canonical !== undefined && Number.isFinite(canonical) && canonical >= 0;
  const result = resolveTimeoutMs({
    envValue: input.env,
    flagValue: canonicalUsable ? canonical : specific,
    defaultMs: OPENCODE_DEFAULT_TASK_TIMEOUT_MS,
  });
  const sourceLabel = result.source === "env"
    ? "env OPENCODE_TIMEOUT_MS"
    : result.source === "flag"
      ? (canonicalUsable ? "flags.timeout" : "flags.opencodeTimeoutMs")
      : "default";
  return { ...result, sourceLabel };
}

export function describeOpencodeTimeout(r: OpencodeTimeoutResolution): string {
  return r.valueMs > 0
    ? `${r.valueMs}ms (${Math.round(r.valueMs / 60_000 * 10) / 10}min) source=${r.sourceLabel}`
    : `disabled (0) source=${r.sourceLabel}`;
}

/**
 * #3103 —— 解析排队上限：`OPENCODE_ADMISSION_CAP_MS` > 默认 10 分钟。
 * 负值/非数字回落到默认；`0` 表示不额外设限（保持单个总预算的旧行为）。
 */
export function resolveAdmissionCapMs(input: { env?: string | undefined } = {}): number {
  const env = flagNumber(input.env);
  if (env !== undefined && Number.isFinite(env) && env >= 0) return env;
  return OPENCODE_DEFAULT_ADMISSION_CAP_MS;
}

/**
 * #3103 —— 把「任务总预算」换算成「排队阶段可用预算」。
 *
 * - 总预算为 0（不设上限）⇒ 排队也不设上限，但排队上限若被显式配置则仍生效
 * - 否则取 min(总预算, 排队上限)，保证排队不会占完整份
 */
export function admissionBudgetFor(budgetMs: number, capMs: number): number {
  const capped = capMs > 0 ? capMs : Number.POSITIVE_INFINITY;
  if (budgetMs <= 0) return Number.isFinite(capped) ? capped : 0;
  const cappedBudget = Math.min(budgetMs, capped);
  return Number.isFinite(cappedBudget) ? cappedBudget : budgetMs;
}
