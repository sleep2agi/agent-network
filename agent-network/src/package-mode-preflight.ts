// Preflight for the condition that made grok-build-cli and opencode-cli
// unstartable on this machine without ever naming itself.
//
// Both runtimes resolve their agent-node payload through npm/npx and then
// refuse to execute it unless `(mode & 0o022) === 0`. npm creates files with
// `0o666 & ~umask` (and 0o777 & ~umask for executables), so on a stock
// Debian/Ubuntu box — where umask is 0002 because every user gets a private
// group — every fetch lands at 0775/0664 and every start dies. The check is
// correct; what was missing is anyone telling the operator BEFORE they hit it.
//
// So `anet doctor` can answer it from local state alone: no network, no npx
// run, just the process umask and whatever payload is already extracted.

export interface UmaskVerdict {
  /** Will a freshly npm-extracted payload fail the (mode & 0o022) === 0 check? */
  willProduceUnsafeModes: boolean;
  /** Octal umask string as an operator would type it. */
  umaskOctal: string;
  /** Which write bits this umask fails to mask off. */
  leaks: Array<"group" | "other">;
}

/**
 * Read a umask value the way the package check will experience it.
 *
 * A umask bit SET means "withhold this permission". So group-write is withheld
 * only when 0o020 is set in the umask; umask 0002 withholds other-write and
 * nothing else, which is exactly the failing case.
 */
export function judgeUmask(umask: number): UmaskVerdict {
  const leaks: Array<"group" | "other"> = [];
  if ((umask & 0o020) === 0) leaks.push("group");
  if ((umask & 0o002) === 0) leaks.push("other");
  return {
    willProduceUnsafeModes: leaks.length > 0,
    umaskOctal: "0" + (umask & 0o777).toString(8).padStart(3, "0"),
    leaks,
  };
}

/** One line for `anet doctor`, or null when there is nothing to say. */
export function describeUmaskRisk(verdict: UmaskVerdict): string | null {
  if (!verdict.willProduceUnsafeModes) return null;
  const who = verdict.leaks.join(" and ");
  return `umask is ${verdict.umaskOctal}, so npm extracts packages ${who}-writable. ` +
    `grok-build-cli and opencode-cli refuse to execute a payload in that state, and the ` +
    `refusal reads as an "Incompatible runtime" error. Start those runtimes under ` +
    `\`umask 0022\`, or run \`chmod -R g-w,o-w\` on the resolved package root.`;
}

export interface ExtractedPayload {
  path: string;
  uid: number;
  mode: number;
}

/**
 * Which already-extracted payloads would be rejected right now.
 *
 * Reports facts about copies that exist on disk; it never fetches. An empty
 * result means "nothing extracted yet", which is not the same as "safe" — the
 * umask verdict is what speaks to the next fetch.
 */
export function rejectedPayloads(payloads: ExtractedPayload[], processUid: number): ExtractedPayload[] {
  return payloads.filter(p => p.uid !== processUid || (p.mode & 0o022) !== 0);
}
