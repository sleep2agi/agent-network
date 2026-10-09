/** V2 remote-created profiles need a TUI on ordinary start. Legacy V1 keeps
 * its explicit --copresence behavior; the bridge must never orchestrate itself.
 * This only selects a launch lane, never authorizes unsafe tools. */
export function opencodeV2CopresenceRequested(
  profile: { runtime?: unknown; opencodeGeneration?: unknown; opencodeMode?: unknown },
): boolean {
  return profile.runtime === "opencode-cli"
    && profile.opencodeGeneration === "v2"
    && profile.opencodeMode === "copresence";
}
