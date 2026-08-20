// Everything `anet node start <name>` needs that it currently only complains
// about, plus the one thing it can honestly do for you.
//
// The complaint-only shape had two costs, both hit in practice:
//
//   1. Whack-a-mole. The guards exit one at a time (tmux at cli.ts ~:495, codex
//      at ~:500), so a machine missing both tells you about tmux, you install
//      it, rerun, and only then learn about codex. A preflight that reports
//      every gap at once costs the same code and one round trip instead of N.
//
//   2. "Install tmux" is advice, not a command. The operator still has to know
//      which package manager this box uses. Naming the exact line removes that.
//
// 🔴 What this deliberately does NOT do: install system packages. That needs
//    sudo and a guess at the package manager, and a launcher that escalates
//    privileges to start a node is a worse trade than one that prints a line to
//    paste. The hub is different — it is our own service, on loopback, and
//    starting it needs no privileges at all. That one we do.

export interface CopresenceDep {
  readonly name: string;
  readonly present: boolean;
  /** Exact command for this platform, or null when we cannot name one. */
  readonly install: string | null;
  readonly why: string;
}

export type CommandProbe = (cmd: string) => boolean;

function installHint(name: string, platform: NodeJS.Platform): string | null {
  if (name === "codex") return "npm install -g @openai/codex";
  if (name === "tmux") {
    if (platform === "darwin") return "brew install tmux";
    if (platform === "linux") return "sudo apt-get install -y tmux   # or: sudo dnf install -y tmux";
    return null;   // windows: no honest one-liner
  }
  if (name === "bun") return "curl -fsSL https://bun.sh/install | bash";
  return null;
}

const DEPS: ReadonlyArray<{ name: string; probes: readonly string[]; why: string }> = [
  { name: "tmux", probes: ["tmux"], why: "isolates the app-server / bridge / TUI trio" },
  { name: "codex", probes: ["codex"], why: "the TUI and the app-server are both codex" },
  // Either binary satisfies it — `anet hub start` accepts bunx or bun. Probing
  // only `bun` would fail on a PATH that carries just `bunx`.
  { name: "bun", probes: ["bunx", "bun"], why: "anet hub start runs the server through bunx" },
];

export function copresenceDeps(probe: CommandProbe, platform: NodeJS.Platform = process.platform): CopresenceDep[] {
  return DEPS.map((d) => ({
    name: d.name,
    present: d.probes.some((p) => probe(p)),
    install: installHint(d.name, platform),
    why: d.why,
  }));
}

export function missingCopresenceDeps(probe: CommandProbe, platform: NodeJS.Platform = process.platform): CopresenceDep[] {
  return copresenceDeps(probe, platform).filter((d) => !d.present);
}

/** One block naming every gap and how to close it — never one gap at a time. */
export function describeMissingDeps(missing: readonly CopresenceDep[], displayName: string): string {
  const lines = [
    `[anet] ❌ ${displayName} needs ${missing.length} thing(s) this machine does not have:`,
  ];
  for (const d of missing) {
    lines.push(`[anet]   • ${d.name} — ${d.why}`);
    lines.push(d.install
      ? `[anet]       ${d.install}`
      : `[anet]       (no install command for this platform — install ${d.name} manually)`);
  }
  lines.push(`[anet]   Then rerun the same command.`);
  return lines.join("\n");
}

/**
 * May we start this hub ourselves?
 *
 * Only a loopback hub. A remote URL that refuses the connection is somebody
 * else's service — spawning a local one would silently point the node at a
 * DIFFERENT hub than its profile names, which is worse than failing.
 */
export function isLoopbackHub(hubUrl: string): boolean {
  try {
    const h = new URL(hubUrl).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch { return false; }
}
