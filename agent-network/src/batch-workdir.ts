import { homedir } from "os";
import { resolve } from "path";

/**
 * Resolve one batch workdir before any mkdir/chdir loop starts.
 *
 * Node does not expand shell tildes. Leaving `~/team` relative means every
 * iteration can resolve it from the previous node's cwd and create paths such
 * as `/work/~/team/~/team`. Only the current user's `~` form is supported;
 * `~other` is rejected instead of being written as a literal directory.
 */
export function normalizeBatchWorkdir(
  input: string,
  cwd = process.cwd(),
  home = homedir(),
): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("batch workdir is empty");

  let expanded = trimmed;
  if (trimmed === "~") {
    expanded = home;
  } else if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    expanded = resolve(home, trimmed.slice(2));
  } else if (trimmed.startsWith("~")) {
    throw new Error(`unsupported home shorthand in batch workdir: ${trimmed}`);
  }

  return resolve(cwd, expanded);
}
