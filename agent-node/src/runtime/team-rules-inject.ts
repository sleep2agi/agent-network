// #993 / RFC-043 §4 (v1) — 启动时把 Hub 层的团队规则注入受管块。
//
// 这一版只做**一层**（Hub）。原因不是偷懒：只有一层时不存在"谁覆盖谁"，
// 所以它不替 RFC §8 的三个产品决定表态。Daemon 层与冲突裁决等决定落地后再加到
// layers 数组里，`renderManagedBlock` 已经支持多层。
//
// 默认关闭（`ANET_TEAM_RULES=1` 才生效）：
//   * 它会改写用户工作目录里的 CLAUDE.md / AGENTS.md —— 这是有感知的副作用，
//     不该因为"代码已合入"就默认发生；
//   * 关闭时**连网络请求都不发**，行为与今天完全一致。
//
// 失败处理遵循 RFC §5：Hub 不可达 → **保留文件原样**（不删块、不写空），并告警；
// 标记损坏 → 拒绝写入并报错，不猜。

import { applyManagedBlock, renderManagedBlock, type RulesLayer } from "./managed-rules-block";
import { readRulesFile, writeRulesFile } from "./rules-file";

export type InjectOutcome =
  | { status: "disabled" }
  | { status: "skipped"; reason: string }
  | { status: "unchanged"; revision: number }
  | { status: "injected"; revision: number; action: "inserted" | "replaced" }
  | { status: "error"; reason: string };

/**
 * #2211 — remember the outcome of the last injection so the node can report it.
 * The Hub then answers "which nodes are on the current rules revision" without
 * pushing anything: v1 injects at full start, so a node that has not restarted is
 * simply *outdated*, not *failed*.
 *
 * Kept in memory only: it describes this process, and a fresh process has not
 * applied anything yet.
 */
export type TeamRulesReport = { revision: number | null; status: InjectOutcome["status"]; reason?: string; at: string };

let lastReport: TeamRulesReport | null = null;

export function recordTeamRulesOutcome(outcome: InjectOutcome, now = new Date().toISOString()): void {
  const revision = "revision" in outcome ? outcome.revision : null;
  const reason = "reason" in outcome ? outcome.reason : undefined;
  lastReport = { revision, status: outcome.status, ...(reason ? { reason } : {}), at: now };
}

/** Undefined when this process never attempted an injection (the field is then omitted, not sent as null). */
export function currentTeamRulesOutcome(): TeamRulesReport | null {
  return lastReport;
}

/** Test seam: forget the recorded outcome. */
export function resetTeamRulesOutcome(): void {
  lastReport = null;
}

export type InjectOptions = {
  /** `ANET_TEAM_RULES=1` 时才为 true。 */
  enabled: boolean;
  hubUrl: string;
  token: string;
  /** 令牌绑定的网络；为空表示这个令牌没有网络作用域（节点令牌一般都有）。 */
  networkId: string | null | undefined;
  workDir: string;
  runtime: string | null | undefined;
  fetchImpl?: typeof fetch;
  warn?: (msg: string) => void;
  /** Hard cap on the Hub fetch. Default 5 s: a node must not hang on a half-open connection. */
  timeoutMs?: number;
};

type RulesResponse = { ok?: boolean; rules?: { content?: string; revision?: number; updated_at?: string | null } };

/** 唯一允许注入的层顺序：目前只有 Hub。多层时按 RFC §2.3 顺序 push。 */
function layersFor(content: string, revision: number, updatedAt: string | null | undefined, networkId: string): RulesLayer[] {
  return [{ source: `Hub / 网络 ${networkId}`, content, revision, updated_at: updatedAt ?? null }];
}

export async function injectTeamRules(opts: InjectOptions): Promise<InjectOutcome> {
  if (!opts.enabled) return { status: "disabled" };
  const warn = opts.warn ?? (() => {});
  if (!opts.networkId) return { status: "skipped", reason: "no_network_scope" };
  if (!opts.hubUrl || !opts.token) return { status: "skipped", reason: "no_hub_credentials" };

  const doFetch = opts.fetchImpl ?? fetch;
  // A refused connection fails fast, but a half-open one does not: without a cap, "injection
  // never blocks startup" (the promise in the startup comment and the runbook) would be false.
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await doFetch(`${opts.hubUrl.replace(/\/$/, "")}/api/networks/${encodeURIComponent(opts.networkId)}/rules`, {
      headers: { Authorization: `Bearer ${opts.token}` },
      signal: controller.signal,
    });
  } catch (err: any) {
    // RFC §5: 不可达时保留旧块。**不写文件**，否则等于静默撤回规则。
    const aborted = controller.signal.aborted;
    warn(`[team-rules] hub ${aborted ? `did not answer within ${timeoutMs}ms` : "unreachable"} (${err?.message ?? err}); keeping the file as-is`);
    return { status: "skipped", reason: aborted ? "hub_timeout" : "hub_unreachable" };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    warn(`[team-rules] hub returned ${res.status}; keeping the file as-is`);
    return { status: "skipped", reason: `hub_http_${res.status}` };
  }
  const body = (await res.json().catch(() => null)) as RulesResponse | null;
  const content = body?.rules?.content;
  const revision = body?.rules?.revision;
  if (typeof content !== "string" || typeof revision !== "number") {
    return { status: "error", reason: "malformed_rules_response" };
  }
  if (content.trim() === "") return { status: "skipped", reason: "no_rules" };

  const block = renderManagedBlock(layersFor(content, revision, body?.rules?.updated_at, opts.networkId), revision);
  if (!block) return { status: "skipped", reason: "empty_block" };

  const existing = await readRulesFile(opts.workDir, opts.runtime);
  const applied = applyManagedBlock(existing.content, block);
  if (applied.action === "refused") {
    warn(`[team-rules] refused to write: ${applied.reason}`);
    return { status: "error", reason: applied.reason };
  }
  if (applied.action === "unchanged") return { status: "unchanged", revision };

  try {
    await writeRulesFile(opts.workDir, opts.runtime, applied.content);
  } catch (err: any) {
    return { status: "error", reason: `write_failed: ${err?.message ?? err}` };
  }
  return { status: "injected", revision, action: applied.action };
}
