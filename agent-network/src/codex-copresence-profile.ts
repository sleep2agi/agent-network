// RFC-030 follow-up — make `anet node start <name>` enough to bring up a codex
// co-presence TUI, and stop the node's own permission posture from being
// silently discarded when it does.
//
// Two defects this addresses, both "the value is written but never read":
//
//   1. `--copresence` was flag-only. grok persists `grokCopresence` on the
//      profile and opencode persists `opencodeMode: "copresence"`; codex
//      persisted nothing, so the flag had to be retyped on every start.
//
//   2. `anet node create` writes `flags.sandboxMode: "danger-full-access"` and
//      `flags.approvalPolicy: "never"` (see codexSdkYoloFlags, with its own
//      `--no-yolo` opt-out), but the co-presence start path computed
//      `opts.dangerFullAccess ? … : "read-only"` and never looked at them. The
//      same node therefore ran full-access on the SDK lane and read-only under
//      `--copresence`, with nothing printed either way.
//
// Deliberately NOT changed: read-only stays the default. The "Risk C
// double-safeguard" (explicit flag + typed confirm + stderr banner) is an
// intentional stance, and quietly inverting it here would be a bigger bug than
// the one being fixed. What changes is that the explicit grant is made ONCE and
// remembered, and that a mismatch is announced instead of applied in silence.

export interface CodexCopresenceProfileFields {
  readonly runtime?: string;
  readonly codexCopresence?: boolean;
  readonly codexCopresenceFullAccess?: boolean;
  readonly flags?: Record<string, unknown>;
  // #1521 — three fields required by `anet node resume <alias>` for
  // codex-copresence nodes. See docs/rfcs/RFC-anet-node-resume-codex-copresence-v7.md
  //
  // NONE of the three is read by `anet node create` / `anet node start` — they
  // are only consulted by `resume`. Old codex-copresence configs without them
  // continue to `start` normally; `resume` fail-closes with a diagnostic that
  // names the missing field(s) and prints the JSON patch template (Q7=C).
  /** Absolute project directory to launch the codex TUI in. Passed as
   *  `-C <dir>` to `codex resume`. Also cross-checked against hub-reported
   *  `session.project_dir` in Phase 4.3. */
  readonly codexProjectDir?: string;
  /** Which launch adapter to use in Phase 3.2. `"codex-standard"` = stock
   *  `codex app-server` + `codex resume`; `"codex-custom-wrapper"` = TMHR狗-class
   *  custom LLM API wrapper (hosted tool / compaction / image-output compat).
   *  Unknown / absent → Phase 0 fail-closed (unknown adapters must not fall
   *  through to a default that might not fit the node's real topology). */
  readonly codexLaunchAdapter?: "codex-standard" | "codex-custom-wrapper";
  /** Alias of the peer that will verify this node's identity in Phase 6.
   *  Peer MUST be (a) registered in the same network, (b) online at resume
   *  time, (c) not this node itself. Identity attestation uses a fresh
   *  Hub outbound `send_task` from THIS node's Bridge to <codexProbePeer>
   *  carrying a nonce; peer echoes the nonce back; CLI cross-checks Hub's
   *  recorded `from_name / from_node_id / to_name / to_node_id`.
   *
   *  🔴 self-loop is deliberately not accepted here — it cannot prove
   *  cross-node routing closure (design v7 Phase 6 = D, per TMHR
   *  06cfb29a). Single-node users cannot run `anet node resume` in
   *  this initial cut; tracked at #1527. */
  readonly codexProbePeer?: string;
}

/** #1521 — the three fields `anet node resume <alias>` requires on a
 *  codex-copresence node. Any missing field is a Phase 0 fail-closed with
 *  actionable diagnostic (see `codexResumeMissingConfigHint`). */
export type CodexResumeRequiredField =
  | "codexProjectDir"
  | "codexLaunchAdapter"
  | "codexProbePeer";

export const CODEX_RESUME_REQUIRED_FIELDS: readonly CodexResumeRequiredField[] = [
  "codexProjectDir",
  "codexLaunchAdapter",
  "codexProbePeer",
];

/** Enumerate which of the three resume-required fields are absent /
 *  wrong-shaped on this profile. Returns [] when all three are present
 *  and well-shaped. Shape check (string / enum / absolute path) only —
 *  liveness of `codexProbePeer` (registered + online + non-self) is a
 *  separate check performed against the hub in Phase 0. */
export function missingCodexResumeFields(
  profile: CodexCopresenceProfileFields,
): CodexResumeRequiredField[] {
  const missing: CodexResumeRequiredField[] = [];
  if (typeof profile.codexProjectDir !== "string" || !profile.codexProjectDir.startsWith("/")) {
    missing.push("codexProjectDir");
  }
  const adapter = profile.codexLaunchAdapter;
  if (adapter !== "codex-standard" && adapter !== "codex-custom-wrapper") {
    missing.push("codexLaunchAdapter");
  }
  if (typeof profile.codexProbePeer !== "string" || profile.codexProbePeer.length === 0) {
    missing.push("codexProbePeer");
  }
  return missing;
}

/** #1521 — actionable multi-line diagnostic for the Q7=C flow: user hits
 *  `anet node resume <alias>` on a legacy codex-copresence node that never
 *  had these fields. Names the missing field(s), the shape requirement,
 *  and — critically — HOW to obtain a valid value (per 通信龙 df6d26d9
 *  "指不出下一步的报错等于把人卡在原地"). Modeled on the style adopted
 *  by #1521 (700b47f6) for `anet_bin_source` diagnostics: every error
 *  ends in a copy-pasteable next step.
 *
 *  Do NOT auto-write the config (TMHR v5 dry-run bonus: "dry-run 是渲染
 *  不是执行"). Print a JSON patch template + the exact command the user
 *  runs against it. */
export function codexResumeMissingConfigHint(
  alias: string,
  missing: readonly CodexResumeRequiredField[],
): string {
  const lines: string[] = [];
  lines.push(`anet node resume ${alias}: cannot start — codex-copresence config is missing ${missing.length} required field(s).`);
  lines.push("");
  lines.push("Missing:");
  for (const f of missing) {
    switch (f) {
      case "codexProjectDir":
        lines.push(`  - codexProjectDir : absolute path to the project directory (passed as \`-C <dir>\` to codex resume)`);
        break;
      case "codexLaunchAdapter":
        lines.push(`  - codexLaunchAdapter : "codex-standard" (stock codex app-server) or "codex-custom-wrapper" (TMHR狗-class LLM API wrapper)`);
        break;
      case "codexProbePeer":
        lines.push(`  - codexProbePeer : alias of another node in this network for identity attestation`);
        lines.push(`      (must be registered + online + NOT this node itself; see #1527 for the single-node case)`);
        break;
    }
  }
  lines.push("");
  lines.push("Fix — write a patch file and apply it:");
  lines.push("");
  lines.push("  cat > /tmp/codex-resume-patch.json <<'EOF'");
  lines.push("  {");
  const patchLines: string[] = [];
  for (const f of missing) {
    switch (f) {
      case "codexProjectDir":
        patchLines.push(`    "codexProjectDir": "<absolute path, e.g. /home/user/my-project>"`);
        break;
      case "codexLaunchAdapter":
        patchLines.push(`    "codexLaunchAdapter": "codex-standard"`);
        break;
      case "codexProbePeer":
        patchLines.push(`    "codexProbePeer": "<peer alias — run 'anet node ls' to pick an online peer>"`);
        break;
    }
  }
  lines.push(patchLines.join(",\n"));
  lines.push("  }");
  lines.push("  EOF");
  lines.push("");
  lines.push(`  anet node config apply ${alias} /tmp/codex-resume-patch.json`);
  lines.push("");
  lines.push("Then re-run:");
  lines.push("");
  lines.push(`  anet node resume ${alias}`);
  if (missing.includes("codexProbePeer")) {
    lines.push("");
    lines.push("🔴 This command needs ≥2 registered nodes online — the target being resumed,");
    lines.push("   plus the codexProbePeer that will attest its identity via a fresh Hub outbound");
    lines.push("   ACK. If you only have one node, see #1527 (single-node attestation is a known");
    lines.push("   deliberate gap in this initial cut, tracked for a follow-up).");
  }
  return lines.join("\n");
}

export const CODEX_COPRESENCE_RUNTIME = "codex-app-server";

/**
 * Should this `anet node start` bring up the co-presence stack?
 *
 * The flag still works for a one-off; the profile field is what makes the
 * second start a single command.
 */
export function codexCopresenceRequested(
  flagPassed: boolean,
  profile: CodexCopresenceProfileFields,
): boolean {
  if (flagPassed) return true;
  return profile.runtime === CODEX_COPRESENCE_RUNTIME && profile.codexCopresence === true;
}

/**
 * True when a plain `anet node start` just became enough for this node — i.e.
 * the flag was passed and the profile had not recorded it yet. Callers persist
 * `codexCopresence: true` and tell the user they can drop the flag.
 */
export function shouldPersistCodexCopresence(
  flagPassed: boolean,
  profile: CodexCopresenceProfileFields,
): boolean {
  return flagPassed
    && profile.runtime === CODEX_COPRESENCE_RUNTIME
    && profile.codexCopresence !== true;
}

export interface CodexCopresencePosture {
  readonly sandboxMode: "danger-full-access" | "read-only";
  readonly approvalPolicy: "never" | "on-request";
  /** Set when the node asked for full access and is NOT getting it. */
  readonly downgradeNotice?: string;
  /** Set when a remembered grant (not this invocation's flag) opened it up. */
  readonly grantedFromProfile: boolean;
}

function declaredFullAccess(profile: CodexCopresenceProfileFields): boolean {
  return profile.flags?.sandboxMode === "danger-full-access";
}

/**
 * Resolve the sandbox the co-presence app-server runs under.
 *
 * Precedence: this invocation's flag → a grant already recorded on the profile
 * → read-only. `flags.sandboxMode` alone never opens the sandbox; it only
 * decides whether staying closed is worth telling the user about.
 */
export function codexCopresencePosture(
  dangerFlagPassed: boolean,
  profile: CodexCopresenceProfileFields,
  displayName = "<node>",
): CodexCopresencePosture {
  const grantedFromProfile = !dangerFlagPassed && profile.codexCopresenceFullAccess === true;
  if (dangerFlagPassed || grantedFromProfile) {
    return { sandboxMode: "danger-full-access", approvalPolicy: "never", grantedFromProfile };
  }
  const notice = declaredFullAccess(profile)
    ? `[anet] ⚠ node ${displayName} is configured flags.sandboxMode=danger-full-access, but co-presence `
      + `starts read-only (approval_policy=on-request) unless full access is granted explicitly.\n`
      + `[anet]   It will not be able to write files. This differs from how the same node behaves off co-presence.\n`
      + `[anet]   To grant it once and have it remembered:\n`
      + `[anet]     anet node start ${displayName} --copresence --dangerously-allow-full-access --yes-danger-full-access`
    : undefined;
  return {
    sandboxMode: "read-only",
    approvalPolicy: "on-request",
    grantedFromProfile: false,
    ...(notice ? { downgradeNotice: notice } : {}),
  };
}

/** True when an explicit grant should be written to the profile for next time. */
export function shouldPersistCodexFullAccess(
  dangerFlagPassed: boolean,
  profile: CodexCopresenceProfileFields,
): boolean {
  return dangerFlagPassed && profile.codexCopresenceFullAccess !== true;
}

/**
 * What `anet node create --runtime codex-app-server` should record, so that a
 * later `anet node start <name>` is a single command with no flag.
 *
 * Shape copied from opencode, which already does exactly this at create time:
 *
 *   ...(runtime === "opencode-cli"
 *     ? { opencodeMode: opts.mode === "copresence" || opts.copresence === "true"
 *         ? "copresence" : "headless" }
 *     : {}),
 *
 * Deliberately NOT keyed on which alias the operator typed. `codex-tui`,
 * `codex-appserver` and `codex-app-server` are documented as aliases of one
 * runtime (agent-node/src/cli.ts); giving one of them a different default would
 * quietly break that contract, and "I typed the short name" is not a reliable
 * statement of intent. Opting in stays explicit, exactly as it is for opencode.
 */
export function codexCopresenceCreateFields(
  normalizedRuntime: string | undefined,
  copresenceOpt: string | boolean | undefined,
): { codexCopresence?: true } {
  if (normalizedRuntime !== CODEX_COPRESENCE_RUNTIME) return {};
  const wanted = copresenceOpt === true || copresenceOpt === "true";
  return wanted ? { codexCopresence: true } : {};
}

/**
 * One line at create time for a node that will start headless.
 *
 * NOT keyed on which alias the operator typed: by the time create builds the
 * profile, `opts.runtime` has already been normalized to `codex-app-server`, so
 * `codex-tui` is simply not recoverable here — a hint that tried to read it
 * would never fire. (It didn't; that is how this was found.) Keying on the
 * runtime instead also keeps the aliases true synonyms.
 */
export function codexCopresenceCreateHint(
  normalizedRuntime: string | undefined,
  copresenceOpt: string | boolean | undefined,
  displayName: string,
): string | undefined {
  if (normalizedRuntime !== CODEX_COPRESENCE_RUNTIME) return undefined;
  if (copresenceOpt === true || copresenceOpt === "true") return undefined;
  return `[anet] note: this node starts headless. For the shared human + agent TUI, run once:\n`
    + `[anet]     anet node start ${displayName} --copresence\n`
    + `[anet]   (it is recorded, so later starts need no flag)`;
}
