// #1462 — resume-continuity acceptance criterion with an explicit `unknown` class.
//
// Context: test751's Windows e2e already asserts the positive path (real CLI
// start/stop/restart + resume/read/TUI counts). Those counts are inline, so
// there was no single place stating *what must never pass*. This module is that
// place: it turns the observations the fixture already collects into
// pass / fail / unknown, and it is what the positive path now goes through.
//
// Discrimination rules (a config cache is never sufficient evidence):
//   - any `thread/start` on the wire          ⇒ fail   (fresh branch observed)
//   - resume/read naming a different thread   ⇒ fail   (wrong thread)
//   - config thread id differs from expected  ⇒ fail
//   - no protocol evidence at all             ⇒ unknown
//   - no `thread/read` for the expected id    ⇒ unknown (history not proven)
//   - no TUI adoption of the expected id      ⇒ unknown
//
// `unknown` must never be reported as a verified resume. Callers decide what to
// do with it; this module only refuses to call it success.

const RPC = /^rpc:([a-z/.-]+)(?::([^\s:]+))?$/;
const TUI = /^tui:([^\s:]+)$/;

export function verifyResumeContinuity({ expectedThreadId, config, transcript, tuiLines }) {
  const reasons = [];
  if (typeof expectedThreadId !== "string" || expectedThreadId.length === 0) {
    return { verdict: "unknown", reasons: ["expected_thread_missing"] };
  }
  const text = String(transcript ?? "");
  const tui = String(tuiLines ?? "");
  if (text.trim().length === 0) {
    return { verdict: "unknown", reasons: ["no_protocol_evidence"] };
  }

  let starts = 0;
  const resumes = [];
  const reads = [];
  for (const line of text.split(/\r?\n/)) {
    const m = RPC.exec(line.trim());
    if (!m) continue;
    if (m[1] === "thread/start") starts += 1;
    if (m[1] === "thread/resume") resumes.push(m[2] ?? "");
    if (m[1] === "thread/read") reads.push(m[2] ?? "");
  }
  const adopted = [];
  for (const line of tui.split(/\r?\n/)) {
    const m = TUI.exec(line.trim());
    if (m) adopted.push(m[1]);
  }

  // Fresh branch on the wire wins over any cached config value.
  if (starts > 0) reasons.push(`fresh_thread_start:${starts}`);

  const wrongResume = resumes.filter((id) => id !== expectedThreadId);
  if (wrongResume.length > 0) reasons.push(`resume_wrong_thread:${wrongResume.join(",")}`);

  const configThread = config && typeof config === "object" ? config.codexThreadId : undefined;
  if (typeof configThread === "string" && configThread !== expectedThreadId) {
    reasons.push(`config_thread_mismatch:${configThread}`);
  }

  if (reasons.length > 0) return { verdict: "fail", reasons };

  // From here on we only have absence of evidence, never evidence of failure.
  if (!resumes.includes(expectedThreadId)) reasons.push("no_resume_for_expected_thread");
  if (!reads.includes(expectedThreadId)) reasons.push("missing_history_read");
  if (!adopted.includes(expectedThreadId)) reasons.push("missing_tui_adoption");
  if (typeof configThread !== "string" || configThread.length === 0) reasons.push("config_missing_thread");
  if (reasons.length > 0) return { verdict: "unknown", reasons };

  return { verdict: "pass", reasons: [`resume:${expectedThreadId}`, `reads:${reads.filter(() => true).length}`] };
}

export function formatVerdict(kind, result) {
  return `${kind}: ${result.verdict.toUpperCase()} (${result.reasons.join("; ")})`;
}
