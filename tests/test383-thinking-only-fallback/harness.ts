// #383 e2e harness — real @anthropic-ai/claude-agent-sdk + real classifier
// against the mock-anthropic SSE endpoint. Two modes replay the SAME walker
// structure that lives at agent-node/src/cli.ts:1898-1931, so this script
// exercises the exact code path except for the outer channel wrapper.
//
// PRE-FIX mode (--pre-fix): uses the legacy formatClassificationError
//   (diagnostic + hardcoded vendor URL + no rescue) → asserts the exact
//   user-visible string that #383 complains about.
//
// POST-FIX mode (--post-fix, default): uses the new
//   formatClassificationForUser + inline rescue re-prompt loop from
//   cli.ts:1917-1926 → asserts the model coaxed out a real text reply,
//   OR fell back to the short vendor-agnostic apology.
//
// Prints structured lines the run.sh orchestrator greps for pass/fail.

import { query } from "@anthropic-ai/claude-agent-sdk";
// Imports the SUT — the classifier + formatter under review. Path is
// bind-mounted into /agent-node-src by Dockerfile.harness so this
// resolves to the branch source (not npm preview).
import {
  classifyRuntimeResult,
  formatClassificationError,
  formatClassificationForUser,
  formatClassificationForLog,
} from "/agent-node-src/src/runtime/classify-result";

const args = process.argv.slice(2);
const PRE_FIX = args.includes("--pre-fix");
const MODE = PRE_FIX ? "PRE-FIX" : "POST-FIX";

function log(...a: unknown[]) {
  console.log(`[harness:${MODE}]`, ...a);
}

// Reset the mock counter before each mode so both runs see the same
// deterministic phase sequence (phase 1 → thinking-only; phase 2+ →
// text-final).
async function resetMock() {
  await fetch(`${process.env.ANTHROPIC_BASE_URL}/_reset`, { method: "GET" });
}

async function main() {
  await resetMock();

  const options: any = {
    // Mock endpoint is our vendor.
    model: "claude-sonnet-4-5-20250929",
    // maxTurns caps runaway; the mock terminates cleanly anyway.
    maxTurns: 3,
    settingSources: [],
  };

  let claudeSessionId = "";
  let inner = "";
  let terminalUsage: any = null;
  let terminalResult = "";
  let terminalCost = 0;
  let terminalNumTurns = 0;

  const prompt = "请查询系统状态。";

  log("starting query()...");
  for await (const message of query({ prompt, options })) {
    const m = message as any;
    if (m.type === "system" && m.subtype === "init") {
      claudeSessionId = m.session_id;
      log(`session=${claudeSessionId?.slice(0, 8)}`);
    }
    if (m.type === "result") {
      terminalUsage = m.usage;
      terminalResult = m.result ?? "";
      terminalCost = m.total_cost_usd ?? 0;
      terminalNumTurns = m.num_turns ?? 0;
      log(`result subtype=${m.subtype} in=${m.usage?.input_tokens} out=${m.usage?.output_tokens} result.length=${terminalResult.length}`);

      if (m.subtype === "success") {
        const cls = classifyRuntimeResult(
          { result: m.result, usage: m.usage, totalCostUsd: m.total_cost_usd },
          { baseUrl: process.env.ANTHROPIC_BASE_URL },
        );
        if (cls.kind === "success") {
          inner = m.result;
        } else if (PRE_FIX) {
          // === Pre-fix code path: single formatter dumps rich diagnostic
          // into user text. No rescue. ===
          log(`✗ ${cls.reason} — using LEGACY formatClassificationError`);
          inner = formatClassificationError(cls, { runtime: "claude-agent-sdk", usage: m.usage });
        } else {
          // === Post-fix code path: mirror cli.ts:1917-1926. ===
          log(`✗ ${cls.reason} — logging full diagnostic, attempting rescue`);
          log(`log-only: ${formatClassificationForLog(cls, { runtime: "claude-agent-sdk", usage: m.usage })}`);

          const isThinkingOnlyShape = cls.kind === "soft-fail-empty"
            && cls.reason === "empty vendor result despite success signal"
            && !!claudeSessionId
            && terminalNumTurns >= 1;

          if (isThinkingOnlyShape) {
            log(`#383 re-prompting for plain-text final (session=${claudeSessionId.slice(0, 8)})`);
            let rescuedText = "";
            try {
              const rescueOptions: any = {
                ...options,
                resume: claudeSessionId,
                maxTurns: 1,
              };
              const rescuePrompt =
                "请用一句面向用户的纯文本给出最终答复（不要用工具，不要 thinking，直接写答案）。";
              for await (const rmsg of query({ prompt: rescuePrompt, options: rescueOptions })) {
                const rm = rmsg as any;
                if (rm.type === "result" && rm.subtype === "success") {
                  rescuedText = rm.result || "";
                  log(`#383 re-prompt got=${rescuedText.length}ch`);
                  break;
                }
              }
            } catch (e: any) {
              log(`#383 re-prompt failed: ${e?.message || e}`);
            }
            if (rescuedText && rescuedText.trim()) {
              inner = rescuedText;
            } else {
              inner = formatClassificationForUser(cls, { runtime: "claude-agent-sdk", usage: m.usage });
            }
          } else {
            inner = formatClassificationForUser(cls, { runtime: "claude-agent-sdk", usage: m.usage });
          }
        }
      } else {
        inner = `执行出错: ${m.error || m.result || "未知错误"}`;
      }
    }
  }

  log(`FINAL inner.length=${inner.length}`);
  console.log(`===${MODE}-USER-VISIBLE-BEGIN===`);
  console.log(inner);
  console.log(`===${MODE}-USER-VISIBLE-END===`);

  // Machine-readable summary for the orchestrator.
  const summary = {
    mode: MODE,
    terminalUsage,
    terminalResultLength: terminalResult.length,
    terminalNumTurns,
    innerLength: inner.length,
    innerStartsWithZhixingchuxi: inner.startsWith("执行出错"),
    innerContainsVendorConsoleUrl: /(chat\.intern-ai\.org\.cn|platform\.minimaxi\.com|platform\.deepseek\.com|console\.anthropic\.com|platform\.xiaomimimo\.com)/.test(inner),
    innerText: inner,
  };
  console.log(`===${MODE}-SUMMARY-JSON===`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`===${MODE}-SUMMARY-JSON-END===`);
}

main().catch((e: any) => {
  console.error(`[harness:${MODE}] FATAL: ${e?.message || e}`);
  console.error(e?.stack);
  process.exit(1);
});
