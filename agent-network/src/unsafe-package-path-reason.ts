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
/** …/node_modules/@sleep2agi/agent-node/dist/cli.js → …/node_modules/@sleep2agi/agent-node (else the path itself). */
function packageRootOf(path: string): string {
  const m = path.match(/^(.*\/node_modules\/@sleep2agi\/agent-node)(?:\/|$)/);
  return m ? m[1] : path;
}

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
        `Fix with \`chmod -R g-w,o-w ${shq(packageRootOf(path))}\`, or run the start under \`umask 0022\` so the next fetch is clean`;
    default:
      return `${path} passed the ownership and mode check`;
  }
}

function shq(s: string): string { return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`; }

export interface DirectoryModeFacts {
  uid: number;
  /** Full st_mode (the sticky bit 0o1000 matters here). */
  mode: number;
  processUid: number;
  /** Is this the package root itself or one of its ancestors? Only changes the wording. */
  ancestorOf?: string;
}

/**
 * #535 (audit P1-2) — the DIRECTORY branch of the agent-node package check used
 * to throw a bare "unsafe ownership or mode" with no path at all. In the audit
 * the offender was an ANCESTOR, `/tmp` (1777), because the npx cache lived
 * under a HOME in /tmp — and nothing in the message said so.
 *
 * Names the exact directory, what is wrong with it, and the command that fixes
 * it. For a sticky world-writable directory (/tmp-like) the fix is NOT chmod —
 * changing /tmp breaks the machine — but moving the npm cache out from under it.
 */
export function describeUnsafeDirectory(path: string, facts: DirectoryModeFacts): string {
  const mode = (facts.mode & 0o7777).toString(8).padStart(3, "0");
  const where = facts.ancestorOf ? ` (an ancestor of the agent-node package at ${facts.ancestorOf})` : "";
  const p = shq(path);
  if (facts.uid !== facts.processUid && facts.uid !== 0) {
    return `directory ${path}${where} is owned by uid ${facts.uid}, not by this process (uid ${facts.processUid}) or root — ` +
      `another account could swap the package. Fix: \`sudo chown $(id -u) ${p}\` (or reinstall the package as this user)`;
  }
  if ((facts.mode & 0o002) !== 0) {
    if ((facts.mode & 0o1000) !== 0) {
      return `directory ${path}${where} is mode ${mode} (world-writable, sticky — like /tmp) — anyone could plant a package beside it. ` +
        `Do NOT chmod it. Keep the npm cache out of it: \`export npm_config_cache="$HOME/.npm"\` with a HOME that is not under ${path}, ` +
        `then start again (the package is fetched once into the new cache)`;
    }
    return `directory ${path}${where} is mode ${mode} (world-writable) — anyone could rewrite the package. Fix: \`chmod o-w ${p}\``;
  }
  if ((facts.mode & 0o020) !== 0) {
    return `directory ${path}${where} is mode ${mode} (group-writable) — the group could rewrite the package. ` +
      `Fix: \`chmod g-w ${p}\` (usually umask 0002 at install time; \`umask 0022\` keeps the next fetch clean)`;
  }
  return `directory ${path}${where} is mode ${mode}, owner uid ${facts.uid}`;
}
