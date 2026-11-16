/** The pin is verified by the caller. Never execute a JS entry through cmd.exe
 * or depend on a shebang/file association on native Windows. */
export function daemonCliLaunch(
  binary: string, args: string[], platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): { command: string; args: string[] } {
  return platform === "win32" && /\.[cm]?js$/i.test(binary)
    ? { command: execPath, args: [binary, ...args] }
    : { command: binary, args };
}
