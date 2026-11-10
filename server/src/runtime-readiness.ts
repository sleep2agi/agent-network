// #622 —— daemon 逐 runtime 自检结果(`config_snapshot.daemon_capabilities.runtime_readiness`)。
//
// 上报侧:agent-node/src/runtime/runtime-readiness.ts。这里两件事:
//   1. report_status 的 zod 形状 —— **收得宽**:任何一格坏都只丢这一格(或整个
//      runtime_readiness),绝不拒掉整份 report(同 create_capability_observed_ms_ago
//      的教训:zod 对象里一个已知字段验证失败 = 整份被拒 = 节点在 hub 上失联)。
//   2. /api/host-supervisors 读取时再消毒一次(库里可能存着任何旧形状)。
//
// 向后兼容:旧 daemon 不报 ⇒ 响应里**没有**这个键(不是 {}、不是 null)。

import { z } from "zod/v4";

export const READINESS_STATES = ["ready", "missing_cli", "not_logged_in", "no_network", "unknown"] as const;
export type ReadinessState = typeof READINESS_STATES[number];

const MAX_RUNTIMES = 16;
const MAX_REASON = 600;

const MAX_JSON_BYTES = 16 * 1024;

/** report_status 里 `daemon_capabilities.runtime_readiness` 的 schema。永不拒整份 report。
 *
 *  🔴 故意只验外形(对象、键数、总字节),逐格消毒放在读取侧 `sanitizeRuntimeReadiness`:
 *     这份 schema 会进每个节点的 `tools/list`(#476 按角色的字节天花板),逐字段声明
 *     一遍要多花 ~500 B;而读取侧本来就必须再消毒一次(库里可能存着任何旧形状)。
 *     总字节上限挡住一个异常 daemon 往库里塞大对象。 */
export const runtimeReadinessSchema = z
  .record(z.string().max(64), z.record(z.string(), z.unknown()))
  .refine((r) => Object.keys(r).length <= MAX_RUNTIMES && JSON.stringify(r).length <= MAX_JSON_BYTES)
  .optional()
  .catch(undefined);

export interface RuntimeReadinessOut {
  ok: boolean;
  state: ReadinessState;
  reason: string;
  version?: string;
  checked_at?: string;
  cli?: string;
  auth?: string;
  network?: string;
  shared_login_count?: number;
  /** Copied only for runtime key `opencode-cli`. */
  generation?: "v1" | "v2";
  accepted?: boolean;
}

const ENUMS: Record<string, readonly string[]> = {
  cli: ["found", "missing", "bundled", "unknown"],
  auth: ["present", "absent", "not_required", "unknown"],
  network: ["reachable", "unreachable", "skipped"],
};

/** 读取侧消毒。返回 undefined 表示「daemon 没报」—— 调用方据此**不输出**这个键。 */
export function sanitizeRuntimeReadiness(raw: unknown): Record<string, RuntimeReadinessOut> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, RuntimeReadinessOut> = {};
  let n = 0;
  for (const [rt, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_RUNTIMES) break;
    if (typeof rt !== "string" || rt.length === 0 || rt.length > 64) continue;
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const e = v as Record<string, unknown>;
    const state: ReadinessState = (READINESS_STATES as readonly string[]).includes(e.state as string)
      ? e.state as ReadinessState
      : "unknown";
    const entry: RuntimeReadinessOut = {
      // ok 只在 state=ready 时可能为真:不让一个自相矛盾的上报朝「没问题」方向错。
      ok: e.ok === true && state === "ready",
      state,
      reason: typeof e.reason === "string" ? e.reason.slice(0, MAX_REASON) : "",
    };
    if (typeof e.version === "string" && e.version.length > 0) entry.version = e.version.slice(0, 64);
    if (typeof e.checked_at === "string" && e.checked_at.length > 0) entry.checked_at = e.checked_at.slice(0, 40);
    for (const k of ["cli", "auth", "network"] as const) {
      if (typeof e[k] === "string" && ENUMS[k].includes(e[k] as string)) entry[k] = e[k] as string;
    }
    if (typeof e.shared_login_count === "number" && Number.isInteger(e.shared_login_count)
        && e.shared_login_count >= 0 && e.shared_login_count <= 100_000) {
      entry.shared_login_count = e.shared_login_count;
    }
    if (rt === "opencode-cli" && (e.generation === "v1" || e.generation === "v2")) {
      entry.generation = e.generation;
      if (typeof e.accepted === "boolean") entry.accepted = e.accepted;
    }
    out[rt] = entry;
    n++;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
