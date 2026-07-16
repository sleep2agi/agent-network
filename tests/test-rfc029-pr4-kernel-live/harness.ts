// RFC-029 PR④ — kernel-live e2e for the opencode-cli ACP shim.
//
// Drives the real release-pinned opencode-ai binary through the real
// openOpencodeRuntime + opencodeThink (agent-node/src/runtime/
// opencode-acp/runtime.ts, shipped in #386). No mock at the vendor
// boundary — the child process is a real `opencode acp` speaking real
// ACP JSON-RPC 2.0 over stdio, and the reply text comes back from a
// live opencode-zen free model.
//
// Scope for this round (PR④):
//   S-happy-live  One turn against opencode/deepseek-v4-flash-free.
//                 Assertions:
//                   - opencode child alive during the turn (pgrep)
//                   - session/new returns a sessionId
//                   - session/prompt returns AT LEAST ONE
//                     agent_message_chunk (the reducer accumulates it
//                     into replyText)
//                   - replyText is non-empty (real upstream free model produced
//                     text). We do NOT hard-pin the response phrasing
//                     since free models paraphrase; length + a loose
//                     regex (word boundary of "hello") is the smell
//                     test.
//                   - stopReason lands (end_turn or similar).
//                   - Clean exit — no orphan opencode processes.
//
// Model is forced to the free tier via the persistent per-node
// `.config/opencode/opencode.json`. Safe runtime startup re-renders its
// allowlisted model into a fresh global-config root, so this exercises the
// same selection path shipped in production without loading arbitrary config.

import { openOpencodeRuntime, opencodeThink } from "/agent-node-src/src/runtime/opencode-acp/runtime";
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FREE_MODEL = process.env.OPENCODE_FREE_MODEL || "opencode/deepseek-v4-flash-free";

function pgrepOpencode(): number[] {
  try {
    const out = execFileSync("pgrep", ["-af", "opencode"], { encoding: "utf-8" });
    return out
      .split("\n")
      .filter((l) => l.includes("opencode") && !l.includes("pgrep") && !l.includes("bun run"))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

function makeWorkDir(): string {
  const dir = join(tmpdir(), `pr4-live-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Force the free model; safe startup copies only this allowlisted selector
  // from the persistent node config into its fresh XDG config root.
  const cfgDir = join(dir, ".config", "opencode");
  mkdirSync(join(dir, ".config"), { mode: 0o700 });
  mkdirSync(cfgDir, { mode: 0o700 });
  writeFileSync(
    join(cfgDir, "opencode.json"),
    JSON.stringify({ model: FREE_MODEL }, null, 2),
    { mode: 0o600 },
  );
  return dir;
}

async function runHappyLive() {
  const workDir = makeWorkDir();
  const projectCwd = join(workDir, "project");
  mkdirSync(projectCwd, { recursive: true });

  const pidsBefore = pgrepOpencode();
  const logs: string[] = [];
  const warns: string[] = [];

  const startedAt = Date.now();
  const runtime = await openOpencodeRuntime({
    cwd: projectCwd,
    workDir,
    expectedVersion: process.env.OPENCODE_VERSION_UNDER_TEST || "1.18.1",
    binarySearchPath: process.env.PATH || "",
    log: (m) => { logs.push(m); process.stderr.write(`[runtime.log] ${m}\n`); },
    warn: (m) => { warns.push(m); process.stderr.write(`[runtime.warn] ${m}\n`); },
  });

  const pidsDuring = pgrepOpencode();

  const outcome = await opencodeThink(runtime, {
    prompt:
      "Reply with just the two words \"hello world\" — lowercase, no punctuation, no other text.",
    cwd: projectCwd,
    workDir,
    sessionId: runtime.sessionId,
    log: (m) => { logs.push(m); process.stderr.write(`[think.log] ${m}\n`); },
    warn: (m) => { warns.push(m); process.stderr.write(`[think.warn] ${m}\n`); },
    // 3-minute idle timeout is fine for a one-shot happy turn; free
    // vendor is usually well under 30s.
    idleTimeoutMs: 3 * 60_000,
  });

  await runtime.client.stop();
  await new Promise((r) => setTimeout(r, 300));
  const pidsAfter = pgrepOpencode();

  const wallMs = Date.now() - startedAt;

  console.log(`===S-happy-live-BEGIN===`);
  console.log(JSON.stringify({
    freeModel: FREE_MODEL,
    wallMs,
    replyText: outcome.replyText,
    replyTextLength: outcome.replyText.length,
    thoughtTextLength: outcome.thoughtText.length,
    sessionId: outcome.sessionId,
    chunks: outcome.state.chunks,
    thoughtChunks: outcome.state.thoughtChunks,
    stopReason: outcome.state.lastStopReason,
    rescued: outcome.rescued,
    usage: outcome.state.usage,
    pidsBefore,
    pidsDuring,
    pidsAfter,
    logsFromRuntime: logs.filter((l) => l.includes("[opencode-acp]") || l.includes("session")),
    warnsFromRuntime: warns.filter((w) => w.includes("[opencode-acp]") || w.includes("session")),
  }, null, 2));
  console.log(`===S-happy-live-END===`);
}

async function main() {
  await runHappyLive();
}

main().catch((e) => {
  console.error("FATAL", e?.stack ?? String(e));
  process.exit(1);
});
