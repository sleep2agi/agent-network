/** Keep in parity with agent-network/src/windows-runtime.ts (independent npm packages). */
export function windowsRuntimeSupported(runtime: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32" || runtime === "claude-agent-sdk";
}
