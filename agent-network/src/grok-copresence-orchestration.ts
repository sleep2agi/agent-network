// `anet node start <name> --copresence` for the grok lane.
//
// What was missing was never the mechanism — the leader socket, the attach
// protocol (src/grok-attach-client.ts) and the profile fields all shipped. What
// was missing is that the last step stayed manual. cli.ts told the operator, in
// as many words:
//
//     [anet]   Start the node first, then attach from a second terminal.
//
// Codex got one command and grok got two, for no reason in the mechanism. This
// module is the missing half: pure decisions only, so the orchestration can be
// asserted without spawning tmux, a hub, or a grok binary.

/** tmux session names. The attachable TUI owns the bare alias so that
 *  `tmux attach -t '=<alias>'` lands a human on the TUI, matching the codex
 *  lane exactly — an operator should not have to remember which runtime a node
 *  uses in order to know where to attach. */
export function grokCopresenceSessions(displayName: string): { node: string; tui: string } {
  return { node: `${displayName}-桥`, tui: displayName };
}

export type GrokAttachSocketState = "missing" | "not_a_socket" | "ready";

/** Readiness is "the attach socket exists AND is a socket", never "the child
 *  process started". A grok leader that dies during startup leaves either no
 *  socket at all or a stale regular file from an aborted run; both used to read
 *  as ready because nothing looked. */
export function grokAttachSocketState(entry: { isSocket(): boolean } | null | undefined): GrokAttachSocketState {
  if (!entry) return "missing";
  return entry.isSocket() ? "ready" : "not_a_socket";
}

/** Set on the node child so that `anet node start` inside the tmux session does
 *  not re-enter this orchestration and fork bomb. The codex lane guards on the
 *  same variable (cli.ts: `process.env.ANET_COPRESENCE_BRIDGE !== "1"`); using a
 *  second name would leave two guards that must be kept in sync by hand. */
export const GROK_COPRESENCE_CHILD_ENV = "ANET_COPRESENCE_BRIDGE";

export interface GrokCopresenceDiagnosis {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

/** One block naming every reason this node cannot run the shared TUI, not one
 *  exit per reason. A node that is both the wrong runtime AND missing its
 *  attach socket should learn both in one run. */
export function diagnoseGrokCopresence(input: {
  runtime: string;
  displayName: string;
  grokCopresence?: boolean;
  grokAttachSocket?: string;
}): GrokCopresenceDiagnosis {
  const lines: string[] = [];
  if (input.runtime !== "grok-build-cli") {
    lines.push(`[anet] ❌ grok --copresence requires runtime=grok-build-cli (node "${input.displayName}" is runtime=${input.runtime}).`);
    lines.push(`[anet]    Create one with: anet node create ${input.displayName} --runtime grok-build-cli`);
  } else if (input.grokCopresence === false) {
    // Explicitly opted out at create time via --grok-headless. Restoring it is a
    // decision, not a repair, so say which decision rather than "not supported".
    lines.push(`[anet] ❌ node "${input.displayName}" was created headless (--grok-headless), so it has no shared TUI.`);
    lines.push(`[anet]    Recreate it without --grok-headless to get one.`);
  }
  if (input.runtime === "grok-build-cli" && !input.grokAttachSocket) {
    lines.push(`[anet] ❌ node "${input.displayName}" has no grokAttachSocket in its config — refusing to guess the bridge identity.`);
    lines.push(`[anet]    Run \`anet doctor --fix\`, or recreate the node.`);
  }
  return { ok: lines.length === 0, lines };
}

/** True when a plain `anet node start <name>` (no flag) should bring the shared
 *  TUI up by itself. The flag is a one-off; the profile is what makes every
 *  later start a single command. */
export function grokCopresenceRequested(
  flagPassed: boolean,
  profile: { runtime?: unknown; grokCopresence?: unknown },
): boolean {
  if (profile.runtime !== "grok-build-cli") return false;
  if (profile.grokCopresence === false) return false;
  return flagPassed || profile.grokCopresence === true;
}
