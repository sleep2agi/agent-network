// RFC-029 PR② — CI-gating deterministic e2e for the ACP shim.
//
// Runs 3 scenarios against the mock-opencode server via the real
// runtime.ts + events.ts + client.ts code paths:
//
//   S-happy       one turn, model emits agent_message_chunks →
//                 replyText === "hello world"; rescued=false.
//   S-thinking    one turn, model emits ONLY thought chunks (no
//                 agent_message_chunk) → runtime's #383 rescue
//                 re-prompts; second prompt returns real text →
//                 replyText === "hello world"; rescued=true.
//   S-load-fails  provided sessionId; mock rejects session/load →
//                 runtime logs "session lost on restart" and falls
//                 back to session/new; turn still completes.
//
// Prints structured lines run.sh can grep for pass/fail.

import {
  openOpencodeRuntime,
  opencodeThink,
} from "/agent-node-src/src/runtime/opencode-acp/runtime";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOCK = "/harness/mock-global/node_modules/opencode-ai/bin/opencode.exe";

async function runScenario(
  label: string,
  mockMode: { thinkingOnly?: boolean; loadFails?: boolean },
  opts: { sessionId?: string; rescueDisabled?: boolean },
) {
  const workDir = mkdtempSync(join(tmpdir(), "opencode-pr2-"));
  // The production child environment intentionally has no test-only toggle.
  // These controls belong to the mock fixture itself, outside the random
  // external runtime cwd that the harness cannot predict in advance.
  const thinkingControl = "/harness/.mock-thinking-only";
  const loadControl = "/harness/.mock-load-fails";
  rmSync(thinkingControl, { force: true });
  rmSync(loadControl, { force: true });
  if (mockMode.thinkingOnly) writeFileSync(thinkingControl, "1\n");
  if (mockMode.loadFails) writeFileSync(loadControl, "1\n");
  const rescueEnv = process.env.ANET_DISABLE_383_REPROMPT;
  if (opts.rescueDisabled) process.env.ANET_DISABLE_383_REPROMPT = "1";
  else delete process.env.ANET_DISABLE_383_REPROMPT;

  const logs: string[] = [];
  const warns: string[] = [];
  try {
    const runtime = await openOpencodeRuntime({
      cwd: workDir,
      workDir,
      sessionId: opts.sessionId,
      binary: MOCK,
      expectedVersion: "1.18.1",
      log: (m) => logs.push(m),
      warn: (m) => warns.push(m),
    });
    const outcome = await opencodeThink(runtime, {
      prompt: "hi",
      cwd: workDir,
      workDir,
      sessionId: runtime.sessionId,
      log: (m) => logs.push(m),
      warn: (m) => warns.push(m),
    });
    await runtime.client.stop();
    console.log(`===${label}-BEGIN===`);
    console.log(JSON.stringify({
      replyText: outcome.replyText,
      thoughtText: outcome.thoughtText,
      sessionId: outcome.sessionId,
      chunks: outcome.state.chunks,
      thoughtChunks: outcome.state.thoughtChunks,
      stopReason: outcome.state.lastStopReason,
      rescued: outcome.rescued,
      usage: outcome.state.usage,
      logsFromRuntime: logs.filter(l => l.includes("[opencode-acp]") || l.includes("session")),
      warnsFromRuntime: warns.filter(w => w.includes("[opencode-acp]") || w.includes("session")),
    }, null, 2));
    console.log(`===${label}-END===`);
  } finally {
    rmSync(thinkingControl, { force: true });
    rmSync(loadControl, { force: true });
    rmSync(workDir, { recursive: true, force: true });
    if (rescueEnv === undefined) delete process.env.ANET_DISABLE_383_REPROMPT;
    else process.env.ANET_DISABLE_383_REPROMPT = rescueEnv;
  }
}

async function main() {
  await runScenario("S-happy", {}, {});
  await runScenario("S-thinking", { thinkingOnly: true }, {});
  await runScenario("S-load-fails", { loadFails: true }, { sessionId: "ses_stale_from_prior_boot" });
}

main().catch((e) => {
  console.error("FATAL", e?.stack ?? String(e));
  process.exit(1);
});
