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
/** Platforms whose PTY / IPC / isolation primitives the grok co-presence lane
 *  has actually been validated on. agent-node refuses anywhere else, and it does
 *  so only after the node has been created and started once:
 *
 *    [agent-node] grok-build-cli co-presence 无法在 darwin 上运行，缺少：
 *                 平台 darwin 尚未验证过共存所需的 PTY / IPC / 隔离原语
 *
 *  Learned the expensive way on a Mac mini: install anet, install agent-node,
 *  create the node, start it — and only then find out the platform is refused.
 *  A one-command launcher that lets someone get that far has not saved them
 *  anything, so say it in the same breath as every other gap. */
export const GROK_COPRESENCE_PLATFORMS: readonly NodeJS.Platform[] = ["linux"];

export function diagnoseGrokCopresence(input: {
  runtime: string;
  displayName: string;
  grokCopresence?: boolean;
  grokAttachSocket?: string;
  platform?: NodeJS.Platform;
}): GrokCopresenceDiagnosis {
  const lines: string[] = [];
  const platform = input.platform ?? process.platform;
  if (!GROK_COPRESENCE_PLATFORMS.includes(platform)) {
    lines.push(`[anet] ❌ grok co-presence does not run on ${platform} — the PTY / IPC / isolation primitives it needs are unvalidated there.`);
    lines.push(`[anet]    agent-node refuses this at startup; nothing on this machine can change that.`);
    lines.push(`[anet]    Supported today: ${GROK_COPRESENCE_PLATFORMS.join(", ")}.`);
  }
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
 *  TUI up by itself.
 *
 * 🔴 Deliberately NOT keyed on `grokCopresence`. That field is set to true at
 *    CREATE time for every grok-build-cli node, so reading it here would silently
 *    change what `anet node start` does for every grok node that already exists —
 *    they would stop running in the foreground and fork into tmux, unasked. Caught
 *    exactly that way: a start without the flag entered the orchestration.
 *
 *    The codex lane looks the same but is not: `codexCopresence` is written only
 *    when the operator passes the flag. So grok needs its own record of the
 *    operator's choice, and `grokCopresenceAuto` is it. */
export function grokCopresenceRequested(
  flagPassed: boolean,
  profile: { runtime?: unknown; grokCopresence?: unknown; grokCopresenceAuto?: unknown },
): boolean {
  if (profile.runtime !== "grok-build-cli") return false;
  if (profile.grokCopresence === false) return false;
  return flagPassed || profile.grokCopresenceAuto === true;
}

/** Record the operator's opt-in so the NEXT start needs no flag — and only then.
 *  Never infer it from `grokCopresence`, which create sets by default. */
export function shouldPersistGrokCopresence(
  flagPassed: boolean,
  profile: { runtime?: unknown; grokCopresenceAuto?: unknown },
): boolean {
  return flagPassed && profile.runtime === "grok-build-cli" && profile.grokCopresenceAuto !== true;
}
