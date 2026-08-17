// Why a resolved agent-node payload failed the supply-chain path check.
//
// The check itself is not the problem — refusing to execute a package that
// someone else can rewrite is right. The problem was the sentence it printed:
// "resolved agent-node package has unsafe ownership or mode" names ownership
// first and never mentions the condition that actually fires on a stock
// Debian/Ubuntu box.
//
// Measured on this machine 2026-08-17: `umask` is 0002, so npm extracts the
// package with dist/cli.js at 0775 and package.json at 0664. Owner is correct.
// `0o775 & 0o022 === 0o020` — the group-write bit alone fails the check, and
// every grok-build-cli start died at that line reading
// `Incompatible grok-build-cli runtime.` Removing the group/other write bits
// let the same command run all the way through to the agent-node process.
//
// So: say which condition failed, on which path, with which mode, and what to
// do about it. Pure function of a stat-like shape so it can be tested without
// a filesystem.

export interface PathModeFacts {
  /** Owner uid of the path. */
  uid: number;
  /** Permission bits (st_mode & 0o777). */
  mode: number;
  /** uid of the process doing the check. */
  processUid: number;
}

export type UnsafePathReason = "owner" | "group-writable" | "world-writable" | null;

/** Which condition makes this path unsafe to execute from, if any. */
export function classifyUnsafePath(facts: PathModeFacts): UnsafePathReason {
  if (facts.uid !== facts.processUid) return "owner";
  if ((facts.mode & 0o002) !== 0) return "world-writable";
  if ((facts.mode & 0o020) !== 0) return "group-writable";
  return null;
}

/**
 * Operator-facing explanation. Names the path, the offending bits, and the
 * command that fixes it — a message that says only "unsafe" leaves the reader
 * guessing between four different conditions.
 */
export function describeUnsafePath(path: string, facts: PathModeFacts): string {
  const reason = classifyUnsafePath(facts);
  const mode = (facts.mode & 0o777).toString(8).padStart(3, "0");
  switch (reason) {
    case "owner":
      return `${path} is owned by uid ${facts.uid}, not by this process (uid ${facts.processUid}) — ` +
        `refusing to execute a payload another account can rewrite`;
    case "world-writable":
      return `${path} is mode ${mode} (world-writable) — refusing to execute a payload anyone can rewrite`;
    case "group-writable":
      return `${path} is mode ${mode} (group-writable) — refusing to execute a payload the group can rewrite. ` +
        `This is usually your umask: on Debian/Ubuntu \`umask 0002\` makes npm extract packages 0775/0664. ` +
        `Fix with \`chmod -R g-w,o-w <package root>\`, or run the start under \`umask 0022\` so the next fetch is clean`;
    default:
      return `${path} passed the ownership and mode check`;
  }
}
