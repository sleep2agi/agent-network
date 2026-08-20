// Running npm / npx / bunx / bun on Windows.
//
// Every one of them is a `.cmd` shim there — including bun, when bun was
// installed through npm rather than its own installer:
//
//     where npm  -> C:\Program Files\nodejs\npm.cmd
//     where bunx -> C:\Program Files\nodejs\bunx.cmd
//
// A `.cmd` file is not an executable image; only a command interpreter can run
// it. `execFile`/`spawn` without a shell therefore fails, and since Node 18.20 /
// 20.12 (CVE-2024-27980) naming the `.cmd` explicitly fails too:
//
//     execFileSync("npm",     […])  ->  ENOENT
//     execFileSync("npm.cmd", […])  ->  EINVAL
//
// Measured on Windows 11 26200 with Node 24.18, npm 11.16 — all four launchers
// ENOENT. That is not a corner case on that host: it is every external launcher
// agent-network uses, so component detection, `anet hub start`, the dashboard,
// the self-upgrade and every version check fail together.
//
// 🔴 The fix is NOT `shell: true`. That concatenates the argument array into one
//    string (Node warns about it as DEP0190) and puts quoting — and therefore
//    injection — in the caller's hands, at sites that interpolate package names
//    and version tags. Instead invoke the interpreter directly with an argv, and
//    do the one piece of quoting ourselves, in one place, with a test.

import {
  execFileSync,
  spawn,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithStringEncoding,
  type SpawnOptions,
} from "child_process";

/** Windows needs a command interpreter to run a .cmd; POSIX runs the file. */
export function launcherNeedsShell(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/**
 * Quote one argument for `cmd.exe /c`.
 *
 * cmd's rules are not the shell's: a double quote is escaped by doubling it,
 * and the metacharacters below must be quoted or cmd will act on them. Anything
 * safe is left bare, so the common case stays readable in a process listing.
 */
export function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** The argv to hand to execFile/spawn so `cmd args…` runs on this platform. */
export function launcherArgv(
  cmd: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string | undefined = process.env.ComSpec,
): { file: string; argv: string[] } {
  if (!launcherNeedsShell(platform)) return { file: cmd, argv: [...args] };
  const line = [cmd, ...args].map(quoteForCmd).join(" ");
  // /d skips AutoRun commands from the registry — otherwise a machine-local
  // AutoRun entry would run inside every launcher call we make.
  // /s + a fully quoted line keeps cmd from stripping quotes it should not.
  return { file: comspec || "cmd.exe", argv: ["/d", "/s", "/c", line] };
}

// execFileSync for a launcher, correct on Windows.
//
// 🔴 Keep execFileSync's own overloads. Collapsing them to `string | Buffer`
//    compiles here and breaks every caller that reads `.trim()` off the result —
//    caught by `npm run typecheck` in test766, not by `bun build`, which does
//    not typecheck.
export function runLauncherSync(
  cmd: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string;
export function runLauncherSync(
  cmd: string,
  args: readonly string[],
  options?: ExecFileSyncOptions,
): Buffer;
export function runLauncherSync(
  cmd: string,
  args: readonly string[],
  options: ExecFileSyncOptions | ExecFileSyncOptionsWithStringEncoding = {},
): string | Buffer {
  const { file, argv } = launcherArgv(cmd, args);
  return execFileSync(file, argv, options as ExecFileSyncOptions) as string | Buffer;
}

/** spawn for a launcher, correct on Windows. */
export function spawnLauncher(cmd: string, args: readonly string[], options: SpawnOptions = {}) {
  const { file, argv } = launcherArgv(cmd, args);
  return spawn(file, argv, options);
}
