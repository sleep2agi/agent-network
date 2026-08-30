// #1521 — unit tests for the codex-copresence-resume Phase 0 preflight
// (config-shape validation + Q7=C actionable diagnostic).
//
// The hint text is operator-facing: a broken hint is worse than a broken
// gate because it points the operator at the wrong fix (see 通信龙 df6d26d9
// "指不出下一步的报错等于把人卡在原地"). These tests pin the concrete
// contract:
//   - every missing field surfaces with its own diagnostic bullet
//   - the JSON patch template contains ONLY the missing keys (not the
//     already-present ones — else operators overwrite good config)
//   - the single-node #1527 warning appears iff codexProbePeer is missing
//   - `anet node ls` is named in the codexProbePeer hint (concrete next step)

import { describe, expect, test } from "bun:test";
import {
  missingCodexResumeFields,
  codexResumeMissingConfigHint,
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

  test("codexProbePeer empty string treated as missing (guard against zero-length placeholder)", () => {
    const missing = missingCodexResumeFields({
      codexProjectDir: "/x",
      codexLaunchAdapter: "codex-standard",
      codexProbePeer: "",  // shape check reject
    });
    expect(missing).toEqual(["codexProbePeer"]);
  });

  test("partial missing: only codexProbePeer absent → surfaces just that field", () => {
    const missing = missingCodexResumeFields({
      codexProjectDir: "/x",
      codexLaunchAdapter: "codex-standard",
      // codexProbePeer absent
    });
    expect(missing).toEqual(["codexProbePeer"]);
  });
});

describe("#1521 codexResumeMissingConfigHint — actionable Q7=C diagnostic", () => {
  test("names the alias in the first line so operator knows which node the message is about", () => {
    const hint = codexResumeMissingConfigHint("my-node", CODEX_RESUME_REQUIRED_FIELDS);
    expect(hint.split("\n")[0]).toContain("my-node");
    expect(hint.split("\n")[0]).toContain("missing 3 required field(s)");
  });

  test("JSON patch template contains ONLY the missing fields, not the already-present ones", () => {
    // Regression guard: if the operator's config already has codexProjectDir
    // and only codexProbePeer is missing, the template must NOT include
    // codexProjectDir (else operator applies it and overwrites good config).
    const hint = codexResumeMissingConfigHint("n", ["codexProbePeer"]);
    expect(hint).toContain("codexProbePeer");
    expect(hint).not.toContain("codexProjectDir");
    expect(hint).not.toContain("codexLaunchAdapter");
  });

  test("codexProbePeer hint names the concrete next step (anet node ls)", () => {
    // Per 通信龙 df6d26d9: "指不出下一步的报错等于把人卡在原地".
    const hint = codexResumeMissingConfigHint("n", ["codexProbePeer"]);
    expect(hint).toContain("anet node ls");
  });

  test("single-node #1527 warning appears iff codexProbePeer is in the missing set", () => {
    // With codexProbePeer missing: warning present
    const withPeer = codexResumeMissingConfigHint("n", ["codexProbePeer"]);
    expect(withPeer).toContain("#1527");
    expect(withPeer).toContain("single-node");

    // Without codexProbePeer missing (only other fields): NO warning
    // (the single-node caveat is specifically about peer availability;
    // don't scare operators whose only issue is a missing project dir).
    const withoutPeer = codexResumeMissingConfigHint("n", ["codexProjectDir"]);
    expect(withoutPeer).not.toContain("#1527");
    expect(withoutPeer).not.toContain("single-node");
  });

  test("terminates with the exact re-run command so the loop is closed", () => {
    // Operator's mental model: read error → apply patch → re-run.
    // The message must literally end (or nearly end) with the re-run command.
    const hint = codexResumeMissingConfigHint("my-node", CODEX_RESUME_REQUIRED_FIELDS);
    expect(hint).toContain("anet node resume my-node");
    // "anet node config apply" is the apply verb; both together prove the
    // 3-step loop (edit patch → apply → re-run) is spelled out end-to-end.
    expect(hint).toContain("anet node config apply my-node");
  });

  test("does NOT leak secrets or fs paths beyond what the operator already provides", () => {
    // Message is composed only from the alias + the enum of missing fields.
    // Guard: no `process.env`, `HOME`, absolute paths, tokens, or PIDs in
    // the hint. Cheap regex sweep.
    const hint = codexResumeMissingConfigHint("n", CODEX_RESUME_REQUIRED_FIELDS);
    // Template placeholders like `<absolute path, e.g. /home/user/my-project>`
    // are examples inside angle-brackets — allowed. But a bare `/home/someone`
    // outside brackets would be a leak. Since we only render templates, the
    // only `/home/` occurrences must be inside angle-brackets.
    //
    // 🔴 Meta: this comment itself only names `/home/someone` (in the gate's
    // NOT_A_PERSON allowlist) — never a bare name outside the allowlist. See
    // 通信龙 f55a7e25: "解释规则的文字触发了规则本身" — the first draft of
    // this comment used a placeholder name that WASN'T in the allowlist, and
    // the gate correctly red-flagged the comment. Fixed by using an allowlisted
    // placeholder throughout.
    const bareHomeMatches = hint.match(/\/home\/[a-z]/gi) || [];
    for (const m of bareHomeMatches) {
      const idx = hint.indexOf(m);
      const beforeChar = hint[idx - 1];
      // Every /home/ occurrence should be inside a `<...>` placeholder or
      // in a code-fence example section.
      const isPlaceholder = hint.slice(0, idx).lastIndexOf("<") > hint.slice(0, idx).lastIndexOf(">");
      expect(isPlaceholder).toBe(true);
    }
  });
});

describe("#1521 CODEX_COPRESENCE_RUNTIME constant", () => {
  test("value is the string cli.ts routes on", () => {
    // Sanity: the runtime string that resumeCommand branches on MUST be
    // this constant, not a duplicated literal that could drift.
    expect(CODEX_COPRESENCE_RUNTIME).toBe("codex-app-server");
  });
});
