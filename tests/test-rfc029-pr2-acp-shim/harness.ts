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

const MOCK = "/harness/mock-opencode-launcher.sh";

async function runScenario(label: string, mockEnv: Record<string, string>, opts: { sessionId?: string; rescueDisabled?: boolean }) {
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of Object.keys(mockEnv)) {
    savedEnv[k] = process.env[k];
    process.env[k] = mockEnv[k];
  }
  const rescueEnv = process.env.ANET_DISABLE_383_REPROMPT;
  if (opts.rescueDisabled) process.env.ANET_DISABLE_383_REPROMPT = "1";
  else delete process.env.ANET_DISABLE_383_REPROMPT;

  const logs: string[] = [];
  const warns: string[] = [];
  try {
    const runtime = await openOpencodeRuntime({
      cwd: "/tmp",
      workDir: "/tmp",
      sessionId: opts.sessionId,
      binary: MOCK,
      log: (m) => logs.push(m),
      warn: (m) => warns.push(m),
    });
    const outcome = await opencodeThink(runtime, {
      prompt: "hi",
      cwd: "/tmp",
      workDir: "/tmp",
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
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (rescueEnv === undefined) delete process.env.ANET_DISABLE_383_REPROMPT;
    else process.env.ANET_DISABLE_383_REPROMPT = rescueEnv;
  }
}

async function main() {
  await runScenario("S-happy", {}, {});
  await runScenario("S-thinking", { MOCK_THINKING_ONLY: "1" }, {});
  await runScenario("S-load-fails", { MOCK_LOAD_FAILS: "1" }, { sessionId: "ses_stale_from_prior_boot" });
}

main().catch((e) => {
  console.error("FATAL", e?.stack ?? String(e));
  process.exit(1);
});
