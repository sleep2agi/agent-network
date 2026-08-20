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
