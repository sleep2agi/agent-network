// agent-network/src/resume-runtime-infer.ts
//
// #1390 — `--resume <id>` / `--resume-latest` imply a claude-code-cli node.
//
// The create command used to gate its whole session-binding block on
// runtime===claude-code-cli, so `anet node create X --resume <id>` WITHOUT an
// explicit `--runtime` silently dropped `--resume` AND left the node as the
// default claude-agent-sdk — the user asked for A and got B with no warning
// (defects ① and ②). This pure decision keeps that inference in one place so
// it can be unit-tested without a hub.
//
// Contract:
//   - resume not requested, or a session already resolved → {} (no change)
//   - resume requested, no explicit runtime → infer claude-code-cli
//   - resume requested, explicit runtime === claude-code-cli → {} (already right)
//   - resume requested, explicit runtime is something else → conflictError
//     (fail loud instead of silently ignoring the flag)
//
// `explicitRuntime` must already be normalized by the caller (via the CLI's
// normalizeRuntime), or be empty/undefined when the user passed no --runtime.

export interface ResumeRuntimeInput {
  /** raw --resume value; "true" means the flag was present with no value */
  resume?: string;
  /** whether --resume-latest was passed */
  resumeLatest?: boolean;
  /** an already-resolved session id, if any (skips inference) */
  session?: string;
  /** normalized --runtime, or empty/undefined when the user passed none */
  explicitRuntime?: string;
}

export interface ResumeRuntimeResult {
  /** runtime to force onto opts when it was left to default */
  inferredRuntime?: string;
  /** set when an explicit non-cli runtime conflicts with --resume */
  conflictError?: string;
}

export const CLAUDE_CODE_CLI = "claude-code-cli";

export function resolveRuntimeForResume(input: ResumeRuntimeInput): ResumeRuntimeResult {
  // #1469 f4 —— 裸 `--resume`（无 id，parseCliOptions 把无值 flag 记成 "true"）
  // 以前被排除在外，判成「没请求 resume」。那不只是少推断一次：runtime 保持
  // 默认 claude-agent-sdk，于是 cli.ts 里以 `=== "claude-code-cli"` 为条件的
  // 整块 session 绑定逻辑被跳过 —— 连 TTY 的交互选单都进不去。用户打了这个
  // flag，却拿到一个没有 resume 的默认 runtime 节点，全程零警告。
  //
  // 用户把 flag 打出来了 = 意图明确，缺的只是 id。所以这里认它是 resume 请求；
  // 「id 从哪来」（选单 / --resume-latest / 非 TTY 下报错）归调用方决定。
  // 空串仍然不算 —— 那是「没打」而不是「打了没给值」。
  const resumeRequested =
    !!input.resume || input.resumeLatest === true;
  if (!resumeRequested || input.session) return {};

  const explicit = input.explicitRuntime || "";
  if (explicit && explicit !== CLAUDE_CODE_CLI) {
    return {
      conflictError:
        `--resume / --resume-latest 只适用于 ${CLAUDE_CODE_CLI}，但 --runtime=${explicit}`,
    };
  }
  if (!explicit) return { inferredRuntime: CLAUDE_CODE_CLI };
  return {};
}
