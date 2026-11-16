/** Native Windows first-run support is deliberately limited to the SDK path. */
export function windowsRuntimeSupported(runtime: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32" || runtime === "claude-agent-sdk";
}
