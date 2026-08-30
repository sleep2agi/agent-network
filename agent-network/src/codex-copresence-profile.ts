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
 *  and well-shaped.
 *
 *  🔴 SHAPE-ONLY validation:
 *    - codexProjectDir : string starting with `/`. This is a CHEAP typo
 *      filter, NOT the security gate. Phase 0 (in #1528) MUST additionally
 *      `realpath`/canonicalize + reject NUL, `/`, and any untrusted target
 *      before passing this value to `codex resume -C <dir>` (per TMHR
 *      4bab8196: "startsWith('/') 不是最终安全门").
 *    - codexLaunchAdapter : enum membership.
 *    - codexProbePeer : non-empty AFTER trim. `.trim()` catches whitespace-
 *      only values like `" "` that would otherwise slip through a naive
 *      length check (per TMHR 4bab8196 附加建议). Liveness (registered +
 *      online + non-self) is a separate hub-side check in Phase 0.
 *
 *  Deliberately NOT included: `codexResumeMissingConfigHint` — the earlier
 *  operator-facing diagnostic that referenced a `config apply` verb that
 *  doesn't exist yet. TMHR 4bab8196 blocked it: staging a hint that names
 *  a non-existent command is the exact "存在 ≠ 会执行" antipattern the
 *  gate lessons keep re-teaching. The hint helper lands with its real
 *  caller (either after `config apply` is implemented in a separate PR,
 *  or reworked to reference existing commands only when #1528 lands). */
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
  // TMHR 4bab8196: trim before length check. `" "` is not a valid peer alias.
  if (typeof profile.codexProbePeer !== "string" || profile.codexProbePeer.trim().length === 0) {
    missing.push("codexProbePeer");
  }
  return missing;
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
