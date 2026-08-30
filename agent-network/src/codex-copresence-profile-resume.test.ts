// #1521 — unit tests for the codex-copresence-resume Phase 0 shape validation.
//
// Historical note (TMHR 4bab8196 blocker on PR #1538):
//   An earlier draft of this file also tested `codexResumeMissingConfigHint`,
//   an operator-facing diagnostic that referenced `anet node config apply`.
//   TMHR flagged that command doesn't exist in the tree — the hint would
//   have shipped a "3-step apply/re-run loop" whose middle step was
//   non-executable, and the tests would have false-greened it as "loop is
//   closed". Classic 存在 ≠ 会执行 pattern. Both the hint helper and its
//   tests are deliberately deferred: they land with a real caller in the
//   PR that either implements `config apply` or reworks the hint to
//   reference existing commands only.

import { describe, expect, test } from "bun:test";
import {
  missingCodexResumeFields,
  CODEX_RESUME_REQUIRED_FIELDS,
  CODEX_COPRESENCE_RUNTIME,
} from "./codex-copresence-profile.js";

describe("#1521 missingCodexResumeFields — Phase 0 shape validation", () => {
  test("empty profile → all three fields missing", () => {
    const missing = missingCodexResumeFields({});
    expect(missing.sort()).toEqual(["codexLaunchAdapter", "codexProbePeer", "codexProjectDir"]);
  });

  test("all three fields present + well-shaped → 0 missing", () => {
    const missing = missingCodexResumeFields({
      codexProjectDir: "/home/user/project",
      codexLaunchAdapter: "codex-standard",
      codexProbePeer: "some-peer-alias",
    });
    expect(missing).toEqual([]);
  });

  test("codexProjectDir must be absolute path (relative rejected as missing)", () => {
    const missing = missingCodexResumeFields({
      codexProjectDir: "relative/path",  // NOT absolute
      codexLaunchAdapter: "codex-standard",
      codexProbePeer: "peer",
    });
    expect(missing).toEqual(["codexProjectDir"]);
  });

  test("codexProjectDir startsWith('/') is a shape check, NOT the final security gate", () => {
    // Regression note: this passes shape check but Phase 0 (in #1528) MUST
    // additionally realpath/canonicalize and reject NUL/`/`/untrusted
    // targets before letting the value reach `codex resume -C <dir>`.
    // TMHR 4bab8196 附加建议: "不能把 startsWith('/') 当最终安全门".
    // This test pins the shape-only intent so any future reader knows
    // NOT to trust this helper's OK result as security clearance.
    const missing = missingCodexResumeFields({
      codexProjectDir: "/",  // shape-valid but semantically dangerous
      codexLaunchAdapter: "codex-standard",
      codexProbePeer: "peer",
    });
    // Shape says OK. Phase 0 must reject on separate grounds.
    expect(missing).toEqual([]);
  });

  test("codexLaunchAdapter enum enforced (unknown value → missing, per v7 fail-closed on unknown adapter)", () => {
    const missing = missingCodexResumeFields({
      codexProjectDir: "/x",
      codexLaunchAdapter: "some-unknown-adapter" as any,
      codexProbePeer: "peer",
    });
    expect(missing).toEqual(["codexLaunchAdapter"]);
  });

  test("codexLaunchAdapter accepts both codex-standard and codex-custom-wrapper (v7 Q5)", () => {
    for (const adapter of ["codex-standard", "codex-custom-wrapper"] as const) {
      const missing = missingCodexResumeFields({
        codexProjectDir: "/x",
        codexLaunchAdapter: adapter,
        codexProbePeer: "peer",
      });
      expect(missing).toEqual([]);
    }
  });

  test("codexProbePeer empty string treated as missing (zero-length placeholder guard)", () => {
    const missing = missingCodexResumeFields({
      codexProjectDir: "/x",
      codexLaunchAdapter: "codex-standard",
      codexProbePeer: "",
    });
    expect(missing).toEqual(["codexProbePeer"]);
  });

  test("codexProbePeer whitespace-only treated as missing (per TMHR 4bab8196 附加建议 — trim before length check)", () => {
    // Without .trim(), `" "` would pass the length > 0 check and reach
    // hub liveness check as an obviously-invalid alias — cheap defensive
    // filter at the shape layer.
    for (const ws of [" ", "  ", "\t", "\n", " \t \n "]) {
      const missing = missingCodexResumeFields({
        codexProjectDir: "/x",
        codexLaunchAdapter: "codex-standard",
        codexProbePeer: ws,
      });
      expect(missing).toEqual(["codexProbePeer"]);
    }
  });

  test("codexProbePeer with leading/trailing whitespace but non-empty core is treated as valid (trim, don't reject)", () => {
    // We trim to check emptiness, we don't mutate the field. A peer alias
    // like " realalias " passes shape check; Phase 0's hub liveness lookup
    // is where trimmed vs raw semantics get decided against the hub schema
    // — not here.
    const missing = missingCodexResumeFields({
      codexProjectDir: "/x",
      codexLaunchAdapter: "codex-standard",
      codexProbePeer: " realalias ",
    });
    expect(missing).toEqual([]);
  });

  test("partial missing: only codexProbePeer absent → surfaces just that field", () => {
    const missing = missingCodexResumeFields({
      codexProjectDir: "/x",
      codexLaunchAdapter: "codex-standard",
    });
    expect(missing).toEqual(["codexProbePeer"]);
  });
});

describe("#1521 CODEX_COPRESENCE_RUNTIME + CODEX_RESUME_REQUIRED_FIELDS constants", () => {
  test("CODEX_COPRESENCE_RUNTIME is the string cli.ts routes on", () => {
    expect(CODEX_COPRESENCE_RUNTIME).toBe("codex-app-server");
  });

  test("CODEX_RESUME_REQUIRED_FIELDS enumerates exactly the three fields validated by missingCodexResumeFields", () => {
    // Sanity: the auditable constant must stay in lockstep with the
    // validator's behavior. If someone adds a fourth field to the
    // validator but forgets the constant (or vice versa), this test
    // fires.
    expect(new Set(CODEX_RESUME_REQUIRED_FIELDS)).toEqual(
      new Set(["codexProjectDir", "codexLaunchAdapter", "codexProbePeer"]),
    );
    expect(CODEX_RESUME_REQUIRED_FIELDS.length).toBe(3);
  });
});
